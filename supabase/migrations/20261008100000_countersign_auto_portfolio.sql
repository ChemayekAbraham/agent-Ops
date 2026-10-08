-- Countersign → support type → (company-managed) automatic portfolio.
--
-- Partner Ops must choose how the partner supports before countersigning:
--   company_managed: the portfolio is created, funded from the partner's
--                    operational float and activated in the same step. It then
--                    enters the Landlord Float Pool and claims empty houses
--                    through the existing triggers.
--   self_support:    nothing is created or taken. The partner picks tenants or
--                    houses on their dashboard; each pick becomes a portfolio
--                    on Partner Ops approval (existing flows).
--
-- Rules (approved 2026-10-08):
--   * contract amount = partner_agreements.partnership_amount (now saved from
--     the sign-off dialog, so the contract, the portfolio and the money taken
--     are one number);
--   * existing open portfolios count toward the contract; only the difference
--     (needed) is created / must be covered;
--   * the operational float must hold AT LEAST `needed`; exactly `needed` is taken;
--   * company-managed terms: 15% for 12 months, Option A = monthly payout,
--     Option B = compounding, payout day = activation day (max 28);
--   * float short → nothing happens (no portfolio, no countersign, no email);
--   * self-support money not allocated after 14 days → one reminder to the
--     partner and Partner Ops, no automatic conversion.

-- 1. Agreement columns --------------------------------------------------------------

ALTER TABLE public.partner_agreements
  ADD COLUMN IF NOT EXISTS support_mode text,
  ADD COLUMN IF NOT EXISTS support_mode_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS support_mode_set_by uuid,
  ADD COLUMN IF NOT EXISTS self_support_allowance numeric,
  ADD COLUMN IF NOT EXISTS auto_portfolio_id uuid,
  ADD COLUMN IF NOT EXISTS self_support_reminded_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_agreements_support_mode_check') THEN
    ALTER TABLE public.partner_agreements
      ADD CONSTRAINT partner_agreements_support_mode_check
      CHECK (support_mode IS NULL OR support_mode IN ('company_managed', 'self_support'));
  END IF;
END $$;

-- 2. What the partner already has toward the contract -------------------------------

CREATE OR REPLACE FUNCTION public._partner_contract_coverage(p_partner_id uuid)
RETURNS TABLE (existing_total numeric, existing_count integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT coalesce(sum(ip.investment_amount), 0)::numeric, count(*)::int
    FROM public.investor_portfolios ip
   WHERE ip.investor_id = p_partner_id
     AND ip.status IN ('active', 'locked', 'pending_ops_approval', 'awaiting_partner_details', 'matured');
$$;

REVOKE ALL ON FUNCTION public._partner_contract_coverage(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._partner_contract_coverage(uuid) TO service_role;

-- 3. Summary for the sign-off dialog (read-only, Partner Ops) ------------------------

CREATE OR REPLACE FUNCTION public.get_countersign_summary(p_partner_id uuid, p_amount numeric DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  a        public.partner_agreements%ROWTYPE;
  v_amount numeric;
  v_exist  numeric;
  v_count  integer;
  v_float  numeric;
  v_needed numeric;
  v_option text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_partner_ops(auth.uid()) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  SELECT * INTO a FROM public.partner_agreements WHERE partner_id = p_partner_id;
  SELECT existing_total, existing_count INTO v_exist, v_count FROM public._partner_contract_coverage(p_partner_id);

  v_amount := coalesce(nullif(p_amount, 0), nullif(a.partnership_amount, 0), 0);
  v_needed := greatest(0, v_amount - v_exist);
  v_float  := coalesce(public.funder_float_available(p_partner_id), 0);

  v_option := coalesce(a.return_option,
    (SELECT CASE ip.roi_mode WHEN 'monthly_payout' THEN 'A'
                             WHEN 'monthly_compounding' THEN 'B' END
       FROM public.investor_portfolios ip
      WHERE ip.investor_id = p_partner_id ORDER BY ip.created_at LIMIT 1));

  RETURN jsonb_build_object(
    'contract_amount', v_amount,
    'stored_amount', coalesce(a.partnership_amount, 0),
    'existing_total', v_exist,
    'existing_count', v_count,
    'needed', v_needed,
    'float_available', v_float,
    'shortfall', greatest(0, v_needed - v_float),
    'covered', v_float >= v_needed,
    'return_option', v_option,
    'support_mode', a.support_mode,
    'countersigned', a.countersigned_at IS NOT NULL OR a.status = 'countersigned',
    'self_support_remaining', CASE WHEN a.support_mode = 'self_support' THEN v_needed END,
    'roi_percentage', 15,
    'duration_months', 12
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_countersign_summary(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_countersign_summary(uuid, numeric) TO authenticated, service_role;

-- 4. The money step, called by generate-partner-agreement before it countersigns -----
-- One transaction: either everything (agreement fields + portfolio + float debit)
-- or nothing. Repeat calls are safe: once the portfolio exists, `needed` is 0.

CREATE OR REPLACE FUNCTION public.countersign_prepare_support(
  p_partner_id     uuid,
  p_amount         numeric,
  p_support_mode   text,
  p_return_option  text,
  p_actor          uuid,
  p_countersign_only boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  a          public.partner_agreements%ROWTYPE;
  v_amount   numeric;
  v_exist    numeric;
  v_count    integer;
  v_needed   numeric;
  v_float    numeric;
  v_option   text;
  v_mode     text;
  v_pid      uuid;
  v_code     text;
  v_group    uuid;
  v_today    date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_roi_mode text;
BEGIN
  IF p_actor IS NULL OR NOT public.is_partner_ops(p_actor) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHORIZED',
      'message', 'Only Partner Operations can countersign.');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('countersign-prepare-' || p_partner_id::text));

  SELECT * INTO a FROM public.partner_agreements WHERE partner_id = p_partner_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_AGREEMENT', 'message', 'No agreement found for this partner.');
  END IF;

  v_mode := coalesce(p_support_mode, a.support_mode);
  IF v_mode IS NULL OR v_mode NOT IN ('company_managed', 'self_support') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SUPPORT_MODE_REQUIRED',
      'message', 'Choose how this partner will support (company-managed or self-support) before countersigning.');
  END IF;

  v_amount := coalesce(nullif(p_amount, 0), nullif(a.partnership_amount, 0), 0);
  IF v_amount < 20000 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_AMOUNT',
      'message', 'The contract amount must be at least UGX 20,000.');
  END IF;

  SELECT existing_total, existing_count INTO v_exist, v_count FROM public._partner_contract_coverage(p_partner_id);
  v_needed := greatest(0, v_amount - v_exist);
  v_float  := coalesce(public.funder_float_available(p_partner_id), 0);

  IF p_countersign_only AND v_needed > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CONTRACT_NOT_COVERED', 'needed', v_needed,
      'message', format('The contract (UGX %s) is more than this partner''s portfolios (UGX %s). Countersign from the Sign-off dialog so the difference is handled.',
                        to_char(v_amount, 'FM999,999,999,999'), to_char(v_exist, 'FM999,999,999,999')));
  END IF;

  IF v_float < v_needed THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLOAT_SHORT',
      'needed', v_needed, 'float_available', v_float, 'shortfall', v_needed - v_float,
      'message', format('Operational float is short by UGX %s. Needed UGX %s, available UGX %s. Nothing was sent.',
                        to_char(v_needed - v_float, 'FM999,999,999,999'),
                        to_char(v_needed, 'FM999,999,999,999'), to_char(v_float, 'FM999,999,999,999')));
  END IF;

  v_option := coalesce(p_return_option, a.return_option);
  IF v_option IS NOT NULL AND v_option NOT IN ('A', 'B') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_RETURN_OPTION', 'message', 'Return option must be A or B.');
  END IF;

  -- Company-managed: create, fund and activate the difference.
  IF v_mode = 'company_managed' AND v_needed > 0 THEN
    IF v_option IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'RETURN_OPTION_REQUIRED',
        'message', 'Choose the Return option (A monthly payout or B compounding) for the portfolio.');
    END IF;
    v_roi_mode := CASE v_option WHEN 'A' THEN 'monthly_payout' ELSE 'monthly_compounding' END;

    v_pid := gen_random_uuid();
    LOOP
      v_code := 'WIP' || to_char(now() AT TIME ZONE 'UTC', 'YYMMDD') || lpad((floor(random()*9000)+1000)::int::text, 4, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.investor_portfolios WHERE portfolio_code = v_code);
    END LOOP;

    -- Debit first (float bucket), under the same key every other path uses, so
    -- the creation trigger sees it and does not charge again.
    v_group := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', p_partner_id, 'amount', v_needed, 'direction', 'cash_out',
          'category', 'partner_funding', 'ledger_scope', 'wallet',
          'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
          'description', format('Operational float deployed to portfolio %s on agreement countersign (float_usage=partner_portfolio_funding)', v_code),
          'source_table', 'investor_portfolios', 'source_id', v_pid,
          'reference_id', v_code, 'linked_party', 'platform'),
        jsonb_build_object(
          'amount', v_needed, 'direction', 'cash_in',
          'category', 'partner_funding', 'ledger_scope', 'platform',
          'description', format('Platform capital received for portfolio %s (agreement countersign)', v_code),
          'source_table', 'investor_portfolios', 'source_id', v_pid,
          'reference_id', v_code, 'linked_party', p_partner_id::text)),
      idempotency_key := 'portfolio-funding-' || v_pid::text);

    INSERT INTO public.investor_portfolios (
      id, investor_id, agent_id, portfolio_code, investment_amount,
      roi_percentage, roi_mode, duration_months, payout_day,
      next_roi_date, maturity_date, status, portfolio_pin, activation_token, auto_reinvest,
      cfo_verified, cfo_verified_at, cfo_verified_by
    ) VALUES (
      v_pid, p_partner_id, p_partner_id, v_code, v_needed,
      15, v_roi_mode, 12, least(extract(day FROM v_today)::int, 28),
      (v_today + interval '1 month')::date, (v_today + interval '12 months')::date,
      'active', lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), false,
      true, now(), p_actor
    );
    -- Triggers on insert: funding (skips: debit exists), Landlord Float Pool
    -- reserve (company-managed), and company-managed house claims.

    INSERT INTO public.wallet_transactions (sender_id, recipient_id, amount, description)
    VALUES (p_partner_id, p_partner_id, v_needed, 'Portfolio funded: ' || v_code);

    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
    VALUES (p_actor, 'countersign_auto_portfolio', 'investor_portfolios', v_pid::text,
      'countersign_auto_portfolio', 'Portfolio created automatically on agreement countersign (company-managed)',
      jsonb_build_object('partner_id', p_partner_id, 'contract_amount', v_amount, 'existing_total', v_exist,
                         'created_amount', v_needed, 'portfolio_code', v_code, 'return_option', v_option,
                         'ledger_group_id', v_group, 'float_before', v_float));
  END IF;

  UPDATE public.partner_agreements
     SET partnership_amount = v_amount,
         partnership_amount_words = CASE WHEN partnership_amount IS DISTINCT FROM v_amount THEN NULL ELSE partnership_amount_words END,
         return_option = coalesce(v_option, return_option),
         support_mode = v_mode,
         support_mode_set_at = CASE WHEN support_mode IS DISTINCT FROM v_mode THEN now() ELSE support_mode_set_at END,
         support_mode_set_by = CASE WHEN support_mode IS DISTINCT FROM v_mode THEN p_actor ELSE support_mode_set_by END,
         self_support_allowance = CASE WHEN v_mode = 'self_support' THEN v_needed ELSE NULL END,
         auto_portfolio_id = coalesce(v_pid, auto_portfolio_id)
   WHERE id = a.id;

  RETURN jsonb_build_object('ok', true, 'support_mode', v_mode, 'contract_amount', v_amount,
    'existing_total', v_exist, 'needed', v_needed, 'float_available', v_float,
    'portfolio_id', v_pid, 'portfolio_code', v_code, 'return_option', v_option,
    'self_support_allowance', CASE WHEN v_mode = 'self_support' THEN v_needed END);
END;
$$;

REVOKE ALL ON FUNCTION public.countersign_prepare_support(uuid, numeric, text, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.countersign_prepare_support(uuid, numeric, text, text, uuid, boolean) TO service_role;

-- 5. Self-support reminder after 14 days ---------------------------------------------
-- In-app notifications are blocked for these types (block_all_notification_inserts),
-- so the reminder is sent by the edge function self-support-unallocated-reminders
-- (SMS + email to the partner, email copy to partnership@welile.com). This RPC
-- claims the due agreements once: it marks them reminded and returns who to tell.
-- Calling it early is harmless: only agreements 14+ days past countersign are due,
-- and each is returned once.

CREATE OR REPLACE FUNCTION public.claim_due_self_support_reminders(p_limit integer DEFAULT 200)
RETURNS TABLE (agreement_id uuid, partner_id uuid, full_name text, email text, phone text,
               contract_amount numeric, remaining numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r       record;
  v_exist numeric;
  v_left  numeric;
BEGIN
  FOR r IN
    SELECT pa.id, pa.partner_id, pa.partnership_amount,
           coalesce(pr.full_name, pa.full_name) AS full_name,
           coalesce(pa.email, pr.email) AS email,
           coalesce(pr.phone, pa.phone) AS phone
      FROM public.partner_agreements pa
      LEFT JOIN public.profiles pr ON pr.id = pa.partner_id
     WHERE pa.support_mode = 'self_support'
       AND pa.countersigned_at IS NOT NULL
       AND pa.countersigned_at <= now() - interval '14 days'
       AND pa.self_support_reminded_at IS NULL
     ORDER BY pa.countersigned_at
     LIMIT greatest(1, least(coalesce(p_limit, 200), 500))
     FOR UPDATE OF pa SKIP LOCKED
  LOOP
    SELECT existing_total INTO v_exist FROM public._partner_contract_coverage(r.partner_id);
    v_left := greatest(0, r.partnership_amount - v_exist);
    UPDATE public.partner_agreements SET self_support_reminded_at = now() WHERE id = r.id;
    IF v_left > 0 THEN
      agreement_id := r.id; partner_id := r.partner_id; full_name := r.full_name;
      email := r.email; phone := r.phone; contract_amount := r.partnership_amount; remaining := v_left;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_due_self_support_reminders(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_self_support_reminders(integer) TO service_role;

-- Daily 09:30 EAT. The cron command is built at apply time from the existing
-- partner-promissory-note-reminders job (same project URL and headers), with
-- only the function name changed.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'self-support-unallocated-reminders';
SELECT cron.schedule(
  'self-support-unallocated-reminders',
  '30 6 * * *',
  (SELECT replace(command, '/functions/v1/partner-promissory-note-reminders',
                           '/functions/v1/self-support-unallocated-reminders')
     FROM cron.job WHERE jobname = 'partner-promissory-note-reminders-0930-eat')
);
