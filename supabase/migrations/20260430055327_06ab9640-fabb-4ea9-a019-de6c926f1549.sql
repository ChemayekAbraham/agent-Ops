
-- ============================================================
-- 1. Diagnostic table: wallet_commission_drift
-- ============================================================
CREATE TABLE IF NOT EXISTS public.wallet_commission_drift (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  raw_commission numeric NOT NULL,
  total_wallet_ledger numeric NOT NULL,
  attempted_amount numeric,
  context text,
  detected_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewer uuid,
  notes text
);

ALTER TABLE public.wallet_commission_drift ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "CFO can view commission drift" ON public.wallet_commission_drift;
CREATE POLICY "CFO can view commission drift"
  ON public.wallet_commission_drift
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role IN ('cfo','super_admin')
    )
  );

-- No insert/update/delete policies → only SECURITY DEFINER functions can write.

CREATE INDEX IF NOT EXISTS idx_wallet_commission_drift_user_detected
  ON public.wallet_commission_drift(user_id, detected_at DESC);

-- ============================================================
-- 2. View: wallet_anchored_balance_drift_view
--    (cached balance < ledger sum → wallet is starving the agent)
-- ============================================================
CREATE OR REPLACE VIEW public.wallet_anchored_balance_drift_view
WITH (security_invoker = on) AS
SELECT
  w.user_id,
  w.balance                  AS cached_balance,
  COALESCE(led.ledger_total, 0)::numeric AS ledger_total,
  (COALESCE(led.ledger_total, 0) - w.balance)::numeric AS understated_by,
  w.updated_at               AS wallet_updated_at
FROM public.wallets w
LEFT JOIN LATERAL (
  SELECT SUM(CASE
    WHEN direction IN ('cash_in','credit') THEN amount
    WHEN direction IN ('cash_out','debit') THEN -amount
    ELSE 0
  END) AS ledger_total
  FROM public.general_ledger
  WHERE user_id = w.user_id AND ledger_scope = 'wallet'
) led ON true
WHERE COALESCE(led.ledger_total, 0) - w.balance >= 1;

-- ============================================================
-- 3. RPC: reseed_anchored_balance (CFO/super_admin)
-- ============================================================
CREATE OR REPLACE FUNCTION public.reseed_anchored_balance(
  p_user_id uuid,
  p_reason  text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor         uuid := auth.uid();
  v_authorized    boolean;
  v_cached        numeric;
  v_ledger_total  numeric;
  v_delta         numeric;
  v_txn_group     uuid := gen_random_uuid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = v_actor AND role IN ('cfo','super_admin')
  ) INTO v_authorized;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'Forbidden: CFO or super_admin only';
  END IF;

  SELECT COALESCE(balance, 0) INTO v_cached
    FROM public.wallets WHERE user_id = p_user_id;

  IF v_cached IS NULL THEN
    RAISE EXCEPTION 'No wallet for user %', p_user_id;
  END IF;

  SELECT COALESCE(SUM(CASE
      WHEN direction IN ('cash_in','credit') THEN amount
      WHEN direction IN ('cash_out','debit') THEN -amount
      ELSE 0
    END), 0)
    INTO v_ledger_total
    FROM public.general_ledger
   WHERE user_id = p_user_id AND ledger_scope = 'wallet';

  v_delta := v_ledger_total - v_cached;

  IF v_delta < 1 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'no_op', true,
      'cached_balance', v_cached,
      'ledger_total',   v_ledger_total
    );
  END IF;

  -- Post a balanced correction pair: credits the user's wallet (which the
  -- sole-writer trigger will use to raise wallets.balance), and debits the
  -- platform via cache_correction_offset.
  PERFORM public.create_ledger_transaction(
    p_transaction_group_id => v_txn_group,
    p_entries => jsonb_build_array(
      jsonb_build_object(
        'user_id',       p_user_id,
        'amount',        v_delta,
        'direction',     'cash_in',
        'category',      'system_balance_correction',
        'ledger_scope',  'wallet',
        'classification','admin_correction',
        'description',   'Anchored balance reseed (cache understated): ' || p_reason,
        'reference_id',  'reseed_balance_' || v_txn_group::text,
        'recipient_type','user'
      ),
      jsonb_build_object(
        'user_id',       NULL,
        'amount',        v_delta,
        'direction',     'cash_out',
        'category',      'phantom_writedown_clearing',
        'ledger_scope',  'platform',
        'classification','admin_correction',
        'description',   'Phantom balance restored during reseed for ' || p_user_id::text,
        'reference_id',  'reseed_balance_' || v_txn_group::text
      )
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'cached_balance', v_cached,
    'ledger_total',   v_ledger_total,
    'delta_credited', v_delta,
    'txn_group',      v_txn_group
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reseed_anchored_balance(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reseed_anchored_balance(uuid, text) TO authenticated;

-- ============================================================
-- 4. Hardened agent_allocate_tenant_payment
--    - Self-heals stale wallets.balance cache before float check
--    - Detects negative raw commission → COMMISSION_LEDGER_INCONSISTENT
--    - Defensive post-check on cached balance after ledger writes
-- ============================================================
CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment(
  p_agent_id uuid,
  p_tenant_id uuid,
  p_rent_request_id uuid,
  p_amount numeric,
  p_notes text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_float_balance numeric;
  v_outstanding numeric;
  v_txn_group uuid := gen_random_uuid();
  v_tracking_id text;
  v_collection_id uuid;
  v_total_wallet numeric;
  v_commission_raw numeric;
  v_commission numeric;
  v_landlord_id uuid;
  v_new_status text;
  v_commission_earned numeric;
  v_current_status text;
  v_total_repayment numeric;
  v_amount_repaid numeric;
  v_cached_balance numeric;
  v_cache_delta numeric;
  v_post_balance numeric;
  v_self_heal_group uuid;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;

  -- ----- Ledger snapshot -----
  SELECT COALESCE(SUM(CASE
      WHEN direction IN ('cash_in','credit') THEN amount
      ELSE -amount END), 0)
    INTO v_total_wallet
    FROM public.general_ledger
   WHERE user_id = p_agent_id AND ledger_scope = 'wallet';

  -- ----- Self-heal anchored balance drift (cache < ledger) -----
  SELECT COALESCE(balance, 0) INTO v_cached_balance
    FROM public.wallets WHERE user_id = p_agent_id;

  v_cache_delta := v_total_wallet - COALESCE(v_cached_balance, 0);

  IF v_cache_delta >= 1 THEN
    v_self_heal_group := gen_random_uuid();
    PERFORM public.create_ledger_transaction(
      p_transaction_group_id => v_self_heal_group,
      p_entries => jsonb_build_array(
        jsonb_build_object(
          'user_id',       p_agent_id,
          'amount',        v_cache_delta,
          'direction',     'cash_in',
          'category',      'system_balance_correction',
          'ledger_scope',  'wallet',
          'classification','admin_correction',
          'description',   'Auto self-heal: wallet cache was below ledger before allocation',
          'reference_id',  'autoheal_' || v_self_heal_group::text,
          'recipient_type','user'
        ),
        jsonb_build_object(
          'user_id',       NULL,
          'amount',        v_cache_delta,
          'direction',     'cash_out',
          'category',      'phantom_writedown_clearing',
          'ledger_scope',  'platform',
          'classification','admin_correction',
          'description',   'Phantom balance restored (auto-heal) for ' || p_agent_id::text,
          'reference_id',  'autoheal_' || v_self_heal_group::text
        )
      )
    );
    -- Re-read after self-heal so downstream uses fresh figures
    SELECT COALESCE(SUM(CASE
        WHEN direction IN ('cash_in','credit') THEN amount
        ELSE -amount END), 0)
      INTO v_total_wallet
      FROM public.general_ledger
     WHERE user_id = p_agent_id AND ledger_scope = 'wallet';
  END IF;

  -- ----- Commission accounting -----
  SELECT COALESCE(SUM(
    CASE
      WHEN direction IN ('cash_in','credit')
        AND category IN (
          'agent_commission_earned','agent_commission','agent_bonus',
          'referral_bonus','proxy_investment_commission',
          'agent_advance_credit','partner_commission'
        )
      THEN amount
      WHEN direction IN ('cash_out','debit')
        AND category IN (
          'agent_commission_withdrawal','agent_commission_used_for_rent',
          'wallet_withdrawal','wallet_transfer','wallet_deduction',
          'wallet_deduction_general_adjustment'
        )
      THEN -amount
      ELSE 0
    END
  ), 0)
  INTO v_commission_raw
  FROM public.general_ledger
  WHERE user_id = p_agent_id
    AND ledger_scope = 'wallet';

  -- If commission ledger is corrupted (more debits than credits), block and log.
  IF v_commission_raw < 0 THEN
    INSERT INTO public.wallet_commission_drift (
      user_id, raw_commission, total_wallet_ledger, attempted_amount, context
    ) VALUES (
      p_agent_id, v_commission_raw, v_total_wallet, p_amount,
      'agent_allocate_tenant_payment'
    );

    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'COMMISSION_LEDGER_INCONSISTENT',
      'error', format(
        'Float allocation paused — your commission ledger is out of balance (raw: %s). Support has been notified.',
        v_commission_raw
      )
    );
  END IF;

  v_commission := GREATEST(0, v_commission_raw);
  v_float_balance := GREATEST(0, v_total_wallet - v_commission);

  IF v_float_balance < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format(
        'Float allocation blocked — would require commission funds. Available float: %s, Requested: %s, Locked commission: %s. Commission cannot be used for tenant payments.',
        v_float_balance, p_amount, v_commission
      )
    );
  END IF;

  -- ----- Rent request lookup -----
  SELECT
    landlord_id,
    status,
    COALESCE(total_repayment, 0),
    COALESCE(amount_repaid, 0),
    GREATEST(0, COALESCE(total_repayment, 0) - COALESCE(amount_repaid, 0))
  INTO
    v_landlord_id,
    v_current_status,
    v_total_repayment,
    v_amount_repaid,
    v_outstanding
  FROM public.rent_requests
  WHERE id = p_rent_request_id
    AND tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rent request not found');
  END IF;

  IF p_amount > v_outstanding THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Amount exceeds outstanding balance of %s', v_outstanding)
    );
  END IF;

  v_tracking_id := 'TPAY-' || to_char(now(), 'YYYYMMDD') || '-' || substring(v_txn_group::text, 1, 8);
  v_commission_earned := ROUND(p_amount * 0.10);

  PERFORM set_config('ledger.authorized', 'true', true);

  -- ----- Float debit (wallet) + tenant_repayment credit (platform) -----
  INSERT INTO public.general_ledger (
    user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id
  ) VALUES (
    p_agent_id, p_amount, 'cash_out', 'agent_float_used_for_rent', 'agent_collections', p_rent_request_id,
    format('Float allocation for tenant payment — %s', v_tracking_id), 'wallet', v_txn_group
  );

  INSERT INTO public.general_ledger (
    user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id
  ) VALUES (
    p_agent_id, p_amount, 'cash_in', 'tenant_repayment', 'agent_collections', p_rent_request_id,
    format('Tenant repayment via agent allocation — %s', v_tracking_id), 'platform', v_txn_group
  );

  -- ----- Commission credit (wallet) + commission expense (platform) -----
  IF v_commission_earned > 0 THEN
    INSERT INTO public.general_ledger (
      user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id
    ) VALUES (
      p_agent_id, v_commission_earned, 'cash_in', 'agent_commission_earned', 'agent_collections', p_rent_request_id,
      format('10%% commission on float allocation — %s', v_tracking_id), 'wallet', v_txn_group
    );

    INSERT INTO public.general_ledger (
      user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id
    ) VALUES (
      p_agent_id, v_commission_earned, 'cash_out', 'agent_commission_earned', 'agent_collections', p_rent_request_id,
      format('Platform commission expense for allocation — %s', v_tracking_id), 'platform', v_txn_group
    );
  END IF;

  -- ----- Rent request progression -----
  v_new_status := CASE
    WHEN v_amount_repaid + p_amount >= v_total_repayment THEN 'completed'
    WHEN v_current_status IN ('funded', 'disbursed', 'coo_approved', 'agent_verified') THEN 'repaying'
    ELSE v_current_status
  END;

  UPDATE public.rent_requests
  SET amount_repaid = COALESCE(amount_repaid, 0) + p_amount,
      status = v_new_status,
      updated_at = now()
  WHERE id = p_rent_request_id;

  INSERT INTO public.repayments (tenant_id, rent_request_id, amount, created_at)
  VALUES (p_tenant_id, p_rent_request_id, p_amount, now());

  INSERT INTO public.agent_collections (
    agent_id, tenant_id, amount, payment_method, tracking_id, notes, float_before, float_after
  ) VALUES (
    p_agent_id,
    p_tenant_id,
    p_amount,
    'cash',
    v_tracking_id,
    p_notes,
    v_float_balance,
    v_float_balance - p_amount
  ) RETURNING id INTO v_collection_id;

  -- ----- Defensive post-check on cached wallet balance -----
  SELECT balance INTO v_post_balance
    FROM public.wallets WHERE user_id = p_agent_id;

  IF v_post_balance IS NOT NULL AND v_post_balance < 0 THEN
    -- Should be impossible after self-heal, but log if it happens.
    INSERT INTO public.wallet_commission_drift (
      user_id, raw_commission, total_wallet_ledger, attempted_amount, context
    ) VALUES (
      p_agent_id, v_commission_raw, v_total_wallet, p_amount,
      'post_check_negative_balance'
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'tracking_id', v_tracking_id,
    'amount', p_amount,
    'float_before', v_float_balance,
    'float_after', v_float_balance - p_amount,
    'outstanding_remaining', GREATEST(0, v_outstanding - p_amount),
    'outstanding_after', GREATEST(0, v_outstanding - p_amount),
    'commission', jsonb_build_object('credited_commission', v_commission_earned),
    'commission_balance', v_commission,
    'collection_id', v_collection_id,
    'self_heal_applied', (v_self_heal_group IS NOT NULL),
    'self_heal_amount', COALESCE(v_cache_delta, 0)
  );
END;
$function$;
