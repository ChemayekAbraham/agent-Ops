-- ============================================================================
-- Restore Agent Float — role-aware wallet routing + one-time reconciliation
-- ============================================================================

-- 1) New 3-arg overload: role-aware router. Keeps the old 2-arg version intact.
CREATE OR REPLACE FUNCTION public.wallet_route_for_category(
  p_user_id uuid,
  p_category text,
  p_direction text
)
RETURNS TABLE(bucket text, sign integer)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_sign int;
  v_is_agent boolean := false;
BEGIN
  -- Direction → sign
  IF p_direction IN ('credit','cash_in') THEN
    v_sign := 1;
  ELSIF p_direction IN ('debit','cash_out') THEN
    v_sign := -1;
  ELSE
    RAISE EXCEPTION 'UNSUPPORTED_LEDGER_DIRECTION: %', p_direction;
  END IF;

  -- Is this user an agent?
  IF p_user_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = p_user_id
        AND role = 'agent'
        AND COALESCE(enabled, true) = true
    ) INTO v_is_agent;
  END IF;

  -- ===== AGENT-SPECIFIC ROUTING (credits only) =====
  -- For agents, these "company money" credits go to FLOAT instead of withdrawable.
  IF v_is_agent AND v_sign = 1 AND p_category IN (
    'wallet_deposit','deposit','wallet_transfer',
    'cfo_direct_credit','system_balance_correction',
    'roi_wallet_credit','roi_payout',
    'pool_capital_received','partner_funding',
    'supporter_capital','supporter_rent_fund',
    'manager_credit'
  ) THEN
    RETURN QUERY SELECT 'float'::text, 1;
    RETURN;
  END IF;

  -- For agents, debits of these float-purpose categories must come out of FLOAT.
  IF v_is_agent AND v_sign = -1 AND p_category IN (
    'agent_proxy_investment','coo_proxy_investment',
    'pending_portfolio_topup','proxy_partner_withdrawal',
    'wallet_transfer','rent_payment_for_tenant','rent_obligation'
  ) THEN
    RETURN QUERY SELECT 'float'::text, -1;
    RETURN;
  END IF;

  -- ===== Fall through to the original (role-blind) routing =====
  RETURN QUERY SELECT * FROM public.wallet_route_for_category(p_category, p_direction);
END;
$function$;

-- 2) Update apply_wallet_movement to call the role-aware router
CREATE OR REPLACE FUNCTION public.apply_wallet_movement(
  p_user_id uuid, p_category text, p_amount numeric, p_direction text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_route record;
  v_recover numeric;
  v_remaining numeric;
  v_current_advance numeric;
  v_current_withdrawable numeric;
  v_current_float numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN; END IF;

  -- ROLE-AWARE ROUTING
  SELECT * INTO v_route FROM public.wallet_route_for_category(p_user_id, p_category, p_direction);

  IF v_route.bucket = 'none' OR v_route.sign = 0 THEN
    BEGIN
      INSERT INTO public.wallet_unrouted_movements (
        user_id, category, direction, amount, bucket_returned, sign_returned
      ) VALUES (
        p_user_id, p_category, p_direction, p_amount, v_route.bucket, v_route.sign
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN;
  END IF;

  PERFORM set_config('wallet.sync_authorized', 'true', true);

  INSERT INTO public.wallets (user_id, balance) VALUES (p_user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT withdrawable_balance, float_balance, advance_balance
    INTO v_current_withdrawable, v_current_float, v_current_advance
    FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;

  IF v_route.bucket = 'withdrawable' AND v_route.sign = 1 THEN
    v_recover := LEAST(p_amount, COALESCE(v_current_advance, 0));
    v_remaining := p_amount - v_recover;
    UPDATE public.wallets
      SET advance_balance = advance_balance - v_recover,
          withdrawable_balance = withdrawable_balance + v_remaining,
          balance = (withdrawable_balance + v_remaining) + float_balance,
          updated_at = now()
      WHERE user_id = p_user_id;

  ELSIF v_route.bucket = 'withdrawable' AND v_route.sign = -1 THEN
    UPDATE public.wallets
      SET withdrawable_balance = withdrawable_balance - p_amount,
          balance = (withdrawable_balance - p_amount) + float_balance,
          updated_at = now()
      WHERE user_id = p_user_id;

  ELSIF v_route.bucket = 'float' AND v_route.sign = 1 THEN
    UPDATE public.wallets
      SET float_balance = float_balance + p_amount,
          balance = withdrawable_balance + (float_balance + p_amount),
          updated_at = now()
      WHERE user_id = p_user_id;

  ELSIF v_route.bucket = 'float' AND v_route.sign = -1 THEN
    UPDATE public.wallets
      SET float_balance = float_balance - p_amount,
          balance = withdrawable_balance + (float_balance - p_amount),
          updated_at = now()
      WHERE user_id = p_user_id;

  ELSIF v_route.bucket = 'advance_credit' THEN
    UPDATE public.wallets
      SET withdrawable_balance = withdrawable_balance + p_amount,
          advance_balance = advance_balance + p_amount,
          balance = (withdrawable_balance + p_amount) + float_balance,
          updated_at = now()
      WHERE user_id = p_user_id;

  ELSIF v_route.bucket = 'advance_repayment' THEN
    UPDATE public.wallets
      SET withdrawable_balance = withdrawable_balance - p_amount,
          advance_balance = GREATEST(0, advance_balance - p_amount),
          balance = (withdrawable_balance - p_amount) + float_balance,
          updated_at = now()
      WHERE user_id = p_user_id;
  END IF;
END;
$function$;

-- 3) ONE-TIME RECONCILIATION
-- For each agent: derive correct withdrawable (commission-only) and float buckets
-- from the ledger using the new routing rules, then rewrite wallet bucket fields.
DO $reconcile$
DECLARE
  r record;
  v_commission_in numeric;
  v_commission_out numeric;
  v_new_withdrawable numeric;
  v_new_float numeric;
  v_total numeric;
  v_advance numeric;
  v_moved_count int := 0;
BEGIN
  PERFORM set_config('wallet.sync_authorized', 'true', true);

  FOR r IN
    SELECT w.user_id, w.withdrawable_balance, w.float_balance, w.advance_balance, w.balance
    FROM public.wallets w
    WHERE EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = w.user_id
        AND ur.role = 'agent'
        AND COALESCE(ur.enabled, true) = true
    )
  LOOP
    -- Commission earned (cash_in side, true earnings)
    SELECT COALESCE(SUM(amount), 0) INTO v_commission_in
    FROM public.general_ledger
    WHERE user_id = r.user_id
      AND ledger_scope = 'wallet'
      AND direction IN ('cash_in','credit')
      AND category IN (
        'agent_commission_earned','agent_commission','agent_bonus',
        'partner_commission','referral_bonus','proxy_investment_commission',
        'agent_investment_commission','salary_payout'
      );

    -- Commission spent / withdrawn
    SELECT COALESCE(SUM(amount), 0) INTO v_commission_out
    FROM public.general_ledger
    WHERE user_id = r.user_id
      AND ledger_scope = 'wallet'
      AND direction IN ('cash_out','debit')
      AND category IN (
        'agent_commission_withdrawal','agent_commission_used_for_rent',
        'wallet_withdrawal'
      );

    v_new_withdrawable := GREATEST(0, v_commission_in - v_commission_out);
    v_total := COALESCE(r.balance, 0);
    v_advance := COALESCE(r.advance_balance, 0);
    -- Float = whatever's left after commission and advance
    v_new_float := GREATEST(0, v_total - v_new_withdrawable - v_advance);

    -- Cap withdrawable at total - advance to keep invariant
    IF v_new_withdrawable > v_total - v_advance THEN
      v_new_withdrawable := GREATEST(0, v_total - v_advance);
      v_new_float := 0;
    END IF;

    -- Only update if buckets actually change
    IF v_new_withdrawable <> COALESCE(r.withdrawable_balance, 0)
       OR v_new_float <> COALESCE(r.float_balance, 0) THEN
      UPDATE public.wallets
        SET withdrawable_balance = v_new_withdrawable,
            float_balance        = v_new_float,
            balance              = v_new_withdrawable + v_new_float,
            updated_at           = now()
        WHERE user_id = r.user_id;
      v_moved_count := v_moved_count + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'Agent wallet reconciliation: % wallets updated', v_moved_count;
END;
$reconcile$;