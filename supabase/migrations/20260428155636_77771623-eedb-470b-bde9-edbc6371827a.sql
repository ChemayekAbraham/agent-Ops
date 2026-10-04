-- ============================================================================
-- Wallet Routing v2 — Recipient-Type Classification
-- Recipient type (user vs operational_wallet) is the SOLE routing signal.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) New diagnostics tables
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wallet_routing_violations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  user_id         uuid,
  category        text,
  direction       text,
  amount          numeric,
  recipient_type  text,
  reason          text NOT NULL,
  context         jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE public.wallet_routing_violations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff can read wallet_routing_violations" ON public.wallet_routing_violations;
CREATE POLICY "staff can read wallet_routing_violations"
  ON public.wallet_routing_violations
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'super_admin')
  );

CREATE TABLE IF NOT EXISTS public.wallet_routing_v2_corrections (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corrected_at             timestamptz NOT NULL DEFAULT now(),
  user_id                  uuid NOT NULL,
  amount_moved             numeric NOT NULL,
  from_bucket              text NOT NULL,
  to_bucket                text NOT NULL,
  source_categories        text[] NOT NULL DEFAULT '{}',
  notes                    text
);

ALTER TABLE public.wallet_routing_v2_corrections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff can read wallet_routing_v2_corrections" ON public.wallet_routing_v2_corrections;
CREATE POLICY "staff can read wallet_routing_v2_corrections"
  ON public.wallet_routing_v2_corrections
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'super_admin')
  );

-- ----------------------------------------------------------------------------
-- 2) Recipient-type router (authoritative for v2)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wallet_route_by_recipient(
  p_recipient_type text,
  p_direction      text
)
RETURNS TABLE(bucket text, sign integer)
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_sign int;
BEGIN
  IF p_recipient_type IS NULL THEN
    RAISE EXCEPTION 'RECIPIENT_TYPE_REQUIRED';
  END IF;

  IF p_direction IN ('credit','cash_in','in') THEN
    v_sign := 1;
  ELSIF p_direction IN ('debit','cash_out','out') THEN
    v_sign := -1;
  ELSE
    RAISE EXCEPTION 'UNSUPPORTED_LEDGER_DIRECTION: %', p_direction;
  END IF;

  IF p_recipient_type = 'user' THEN
    RETURN QUERY SELECT 'withdrawable'::text, v_sign;
    RETURN;
  ELSIF p_recipient_type = 'operational_wallet' THEN
    RETURN QUERY SELECT 'float'::text, v_sign;
    RETURN;
  ELSE
    RAISE EXCEPTION 'INVALID_RECIPIENT_TYPE: %', p_recipient_type;
  END IF;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 3) Backend guard: category vs recipient mismatch detector
--    Used by the new apply_wallet_movement overload.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_routing_compatible(
  p_category       text,
  p_recipient_type text
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
BEGIN
  -- These categories represent money OWNED by an individual.
  -- They must never be routed into an operational/float wallet.
  IF p_recipient_type = 'operational_wallet' AND p_category IN (
    'payroll_expense','salary_payout',
    'roi_wallet_credit','roi_payout',
    'agent_commission_earned','agent_commission','agent_bonus',
    'partner_commission','referral_bonus',
    'proxy_investment_commission','agent_investment_commission',
    'system_balance_correction','wallet_transfer','manager_credit',
    'marketing_expense','general_admin_expense','research_development_expense',
    'tax_expense','interest_expense','equipment_expense'
  ) THEN
    RAISE EXCEPTION 'INVALID_ROUTING: category % cannot target an operational wallet (must go to a user)', p_category
      USING ERRCODE = 'check_violation';
  END IF;

  -- These categories represent operational/company funds.
  -- They must never be routed into a user's withdrawable bucket.
  IF p_recipient_type = 'user' AND p_category IN (
    'agent_float_deposit','agent_float_assignment','agent_float_topup',
    'agent_float_funding','rent_float_funding','rent_disbursement'
  ) THEN
    RAISE EXCEPTION 'INVALID_ROUTING: category % cannot target a user wallet (must go to an operational wallet)', p_category
      USING ERRCODE = 'check_violation';
  END IF;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 4) New apply_wallet_movement overload (5-arg, recipient-type aware)
--    Legacy 4-arg version stays in place for rent engine, ROI cron, etc.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_wallet_movement(
  p_user_id        uuid,
  p_category       text,
  p_amount         numeric,
  p_direction      text,
  p_recipient_type text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_route record;
  v_current_withdrawable numeric;
  v_current_float        numeric;
  v_current_advance      numeric;
  v_recover              numeric;
  v_remaining            numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN; END IF;

  -- Validate recipient type up front. If invalid, log + raise.
  IF p_recipient_type IS NULL OR p_recipient_type NOT IN ('user','operational_wallet') THEN
    BEGIN
      INSERT INTO public.wallet_routing_violations (
        user_id, category, direction, amount, recipient_type, reason, context
      ) VALUES (
        p_user_id, p_category, p_direction, p_amount, p_recipient_type,
        'RECIPIENT_TYPE_REQUIRED',
        jsonb_build_object('source', 'apply_wallet_movement_v2')
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RAISE EXCEPTION 'RECIPIENT_TYPE_REQUIRED'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Category vs recipient compatibility.
  BEGIN
    PERFORM public.assert_routing_compatible(p_category, p_recipient_type);
  EXCEPTION WHEN check_violation THEN
    BEGIN
      INSERT INTO public.wallet_routing_violations (
        user_id, category, direction, amount, recipient_type, reason, context
      ) VALUES (
        p_user_id, p_category, p_direction, p_amount, p_recipient_type,
        SQLERRM,
        jsonb_build_object('source', 'apply_wallet_movement_v2')
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RAISE;
  END;

  SELECT * INTO v_route FROM public.wallet_route_by_recipient(p_recipient_type, p_direction);

  PERFORM set_config('wallet.sync_authorized', 'true', true);

  INSERT INTO public.wallets (user_id, balance) VALUES (p_user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT withdrawable_balance, float_balance, advance_balance
    INTO v_current_withdrawable, v_current_float, v_current_advance
    FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;

  IF v_route.bucket = 'withdrawable' AND v_route.sign = 1 THEN
    -- Sweep advance debt first, then credit withdrawable
    v_recover   := LEAST(p_amount, COALESCE(v_current_advance, 0));
    v_remaining := p_amount - v_recover;
    UPDATE public.wallets
       SET advance_balance      = advance_balance - v_recover,
           withdrawable_balance = withdrawable_balance + v_remaining,
           balance              = (withdrawable_balance + v_remaining) + float_balance,
           updated_at           = now()
     WHERE user_id = p_user_id;

  ELSIF v_route.bucket = 'withdrawable' AND v_route.sign = -1 THEN
    UPDATE public.wallets
       SET withdrawable_balance = withdrawable_balance - p_amount,
           balance              = (withdrawable_balance - p_amount) + float_balance,
           updated_at           = now()
     WHERE user_id = p_user_id;

  ELSIF v_route.bucket = 'float' AND v_route.sign = 1 THEN
    UPDATE public.wallets
       SET float_balance = float_balance + p_amount,
           balance       = withdrawable_balance + (float_balance + p_amount),
           updated_at    = now()
     WHERE user_id = p_user_id;

  ELSIF v_route.bucket = 'float' AND v_route.sign = -1 THEN
    UPDATE public.wallets
       SET float_balance = float_balance - p_amount,
           balance       = withdrawable_balance + (float_balance - p_amount),
           updated_at    = now()
     WHERE user_id = p_user_id;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.apply_wallet_movement(uuid,text,numeric,text,text) IS
  'Wallet Routing v2: recipient-type-driven. Routes purely on p_recipient_type (user => withdrawable, operational_wallet => float). Category is for accounting only.';

-- ----------------------------------------------------------------------------
-- 5) ONE-TIME RECONCILIATION
--    For each agent wallet: sum historical "user-owned" credits that ended up
--    in float (payroll, ROI, commissions, balance corrections, admin/marketing
--    reimbursements). Move that amount from float -> withdrawable, capped at
--    current float_balance. Audit each move.
-- ----------------------------------------------------------------------------
DO $reconcile$
DECLARE
  r record;
  v_user_owned_in_float numeric;
  v_to_move             numeric;
  v_categories          text[];
  v_corrected_count     int := 0;
BEGIN
  PERFORM set_config('wallet.sync_authorized', 'true', true);

  FOR r IN
    SELECT w.user_id, w.withdrawable_balance, w.float_balance, w.balance
      FROM public.wallets w
     WHERE w.float_balance > 0
       AND EXISTS (
         SELECT 1 FROM public.user_roles ur
          WHERE ur.user_id = w.user_id
            AND ur.role = 'agent'
            AND COALESCE(ur.enabled, true) = true
       )
  LOOP
    -- Sum credits that should have been withdrawable but were force-routed to float.
    SELECT
      COALESCE(SUM(amount), 0),
      COALESCE(array_agg(DISTINCT category) FILTER (WHERE amount > 0), '{}')
    INTO v_user_owned_in_float, v_categories
    FROM public.general_ledger
    WHERE user_id = r.user_id
      AND ledger_scope = 'wallet'
      AND direction IN ('cash_in','credit')
      AND category IN (
        'payroll_expense','salary_payout',
        'roi_wallet_credit','roi_payout',
        'system_balance_correction','wallet_transfer','manager_credit',
        'marketing_expense','general_admin_expense','research_development_expense',
        'tax_expense','interest_expense','equipment_expense'
      );

    v_to_move := LEAST(COALESCE(v_user_owned_in_float, 0), COALESCE(r.float_balance, 0));

    IF v_to_move > 0 THEN
      UPDATE public.wallets
         SET float_balance        = float_balance - v_to_move,
             withdrawable_balance = withdrawable_balance + v_to_move,
             balance              = (withdrawable_balance + v_to_move) + (float_balance - v_to_move),
             updated_at           = now()
       WHERE user_id = r.user_id;

      INSERT INTO public.wallet_routing_v2_corrections (
        user_id, amount_moved, from_bucket, to_bucket, source_categories, notes
      ) VALUES (
        r.user_id, v_to_move, 'float', 'withdrawable', v_categories,
        'Wallet Routing v2 one-time reconciliation: user-owned credits previously force-routed to float.'
      );

      v_corrected_count := v_corrected_count + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'Wallet Routing v2 reconciliation complete: % wallets corrected', v_corrected_count;
END;
$reconcile$;