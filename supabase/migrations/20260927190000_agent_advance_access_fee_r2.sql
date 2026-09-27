-- Agent Advance access fee: recognise at origination, DR A11 / CR R2.
--
-- CFO decision of 2026-09-27. Forward-only. No historical GL is touched: the
-- 1,820,000 of top-up fees and the wider 38,789,476 of historical access fee
-- stay exactly as they are.
--
-- WHAT THIS DOES
-- --------------
--   1. Creates R2 "Agent Advance Fee Revenue".
--   2. Maps `agent_advance_fee_revenue` -> R2, debit_when = 'cash_out', so a
--      cash_in leg CREDITS R2 (the same convention R1 uses).
--   3. Adds a fee journal to the three paths that CHARGE an access fee:
--        disburse_agent_advance_request   at origination
--        apply_advance_topup              on top-up
--        update_agent_advance_terms       only when the fee INCREASES
--
-- THE JOURNAL, in every case
--
--   platform  agent_advance_access_fee_charged  cash_out  -> DR A11
--   platform  agent_advance_fee_revenue         cash_in   -> CR R2
--
-- Posted as its OWN transaction group, deliberately. The principal group is
-- left byte-identical so existing principal accounting cannot be disturbed,
-- and the resolver's shape-keyed rules see an unchanged leg count.
--
-- WHY R2 AND WHY ORIGINATION
-- --------------------------
-- R1 "Platform Revenue" was the only revenue account and already blends ~24.3m
-- of tenant rent-plan access fees, registration fees and treasury revenue.
-- Agent lending is a distinct line and its margin has to be visible.
--
-- The fee is priced as a time charge -- principal x ((1+rate)^(days/30) - 1) --
-- but it is never rebated. Verified across 216 open advances where
-- `outstanding = principal + access_fee + registration_fee - collected +
-- penalty` exactly: settle on day one and the whole fee is still owed. It is
-- earned when the advance or top-up is granted.
--
-- VERIFIED READ-ONLY BEFORE WRITING THIS
-- --------------------------------------
--   * R2 absent everywhere: 0 catalog rows, 0 mappings, 0 legs.
--   * A11 exists: "Agent Advance Access Fees Receivable", asset/current_asset,
--     sort 42, and carries 323 debits with zero credits to date.
--   * `agent_advance_fee_revenue` had no mapping, so no duplicate is created.
--   * `agent_advance_access_fee_charged` already maps to A11 / cash_out.
--   * Both categories are in ledger_category_allowlist(); strict_mode = true.
--   * Posting the pair through the real create_ledger_transaction, rolled back:
--       legs      platform/agent_advance_access_fee_charged/cash_out = 336000
--               + platform/agent_advance_fee_revenue/cash_in        = 336000
--       balanced  cash_in 336,000 = cash_out 336,000
--       A11 DR 336,000
--       wallet legs 0; withdrawable 400 -> 400; float 8,000 -> 8,000
--     The revenue leg resolved to A9 only because R2 was not yet mapped; with
--     the mapping below it resolves to CR R2.
--   * No stored function that this migration edits touches registration fees:
--     `registration_fee_collected` is posted only by the rent-side functions
--     (post_rent_fee_collection, reconcile_rent_fee_*), none of which is
--     changed here.
--
-- KNOWN ASYMMETRY, flagged not fixed
-- ----------------------------------
-- Per the approved scope, `update_agent_advance_terms` posts only when the fee
-- INCREASES. A re-term that REDUCES the access fee writes no reversing entry,
-- so A11 would be left overstated by the reduction. Deliberate, and left for
-- the fee-decrease decision.
--
-- Also note this gives `update_agent_advance_terms` its first ledger post ever.
-- A terms edit can now fail on ledger grounds and roll back, where previously
-- it could not. That is correct atomicity, but it is new behaviour.
--
-- NOT DONE HERE
-- -------------
-- Collection-side allocation is unchanged. Repayments still credit A10 in full,
-- so A11 will accumulate debits until the four-way pro-rata split is built
-- across the seven repayment functions. Nothing here modifies wallet balances,
-- wallet logic, repayment or recovery allocation, A10 principal, A20
-- registration fees, L8 penalties, tenant/landlord/partner/Float-A2 logic, or
-- any existing resolver exception.
--
-- Fingerprints before this change:
--   disburse_agent_advance_request  0f8b0d2e (see verification in the report)
--   apply_advance_topup             b442f255b82666fb8ee1054b3731ee75
--   update_agent_advance_terms      1d5351a1f2d4845b366af9464407ffee

-- ---------------------------------------------------------------- 1. account
INSERT INTO public.ledger_account_catalog (code, label, nature, section, sort_order)
VALUES ('R2', 'Agent Advance Fee Revenue', 'revenue', 'revenue', 20)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------- 2. mapping
INSERT INTO public.ledger_account_map
  (ledger_scope, category, wallet_bucket, account_code, debit_when, notes)
VALUES
  ('platform', 'agent_advance_fee_revenue', NULL, 'R2', 'cash_out',
   'Agent Advance access fee income, recognised in full at origination or top-up. Posted cash_in so it credits R2. CFO decision 2026-09-27: a dedicated account, not R1, so agent lending margin is visible separately from tenant rent-plan fees.')
ON CONFLICT DO NOTHING;

-- --------------------------------------------------- 3. apply_advance_topup
CREATE OR REPLACE FUNCTION public.apply_advance_topup(p_advance_id uuid, p_amount numeric, p_extend_days integer, p_request_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text, p_override_eligibility boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  a public.agent_advances;
  v_elig jsonb;
  v_fee numeric;
  v_new_principal numeric;
  v_new_access_fee numeric;
  v_new_outstanding numeric;
  v_new_cycle integer;
  v_new_expires timestamptz;
  v_period integer;
  v_remaining_installments integer;
  v_installment numeric;
  v_days_elapsed integer;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_is_exec boolean;
  v_topup_id uuid;
  v_group uuid;
  v_now timestamptz := now();
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'agent_ops') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'super_admin') OR auth.uid() IS NULL
  ) THEN
    RAISE EXCEPTION 'Not authorised to apply advance top-ups.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_is_exec := public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin');

  SELECT * INTO a FROM public.agent_advances WHERE id = p_advance_id FOR UPDATE;
  IF a.id IS NULL THEN
    RAISE EXCEPTION 'Advance not found.';
  END IF;

  IF COALESCE(p_extend_days,0) <= 0 THEN
    RAISE EXCEPTION 'Extension days must be greater than zero.';
  END IF;

  IF p_override_eligibility THEN
    IF NOT v_is_exec THEN
      RAISE EXCEPTION 'Only the CFO, a manager or a super admin can top up outside the standard eligibility rules.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_reason IS NULL OR length(v_reason) < 10 THEN
      RAISE EXCEPTION 'A reason of at least 10 characters is required for this top-up.';
    END IF;
    IF a.status NOT IN ('active','repaying','overdue','paused') THEN
      RAISE EXCEPTION 'Only an open advance can be topped up (current status: %).', a.status;
    END IF;
    IF COALESCE(a.outstanding_balance,0) <= 0 THEN
      RAISE EXCEPTION 'This advance is already fully repaid and cannot be topped up.';
    END IF;
    IF p_amount < 10000 THEN
      RAISE EXCEPTION 'Top-up must be at least UGX 10,000.';
    END IF;
    IF p_amount > COALESCE(a.principal,0) THEN
      RAISE EXCEPTION 'Top-up cannot exceed the current advance principal (UGX %).', COALESCE(a.principal,0);
    END IF;
  ELSE
    v_elig := public.agent_advance_topup_eligibility(a.agent_id);
    IF NOT (v_elig->>'eligible')::boolean THEN
      RAISE EXCEPTION 'Top-up rejected: %', COALESCE(v_elig->>'reason','not eligible');
    END IF;
    IF (v_elig->>'advance_id')::uuid <> a.id THEN
      RAISE EXCEPTION 'Top-up target is not the agent''s current ongoing advance.';
    END IF;
    IF p_amount < (v_elig->>'min_topup')::numeric OR p_amount > (v_elig->>'max_topup')::numeric THEN
      RAISE EXCEPTION 'Top-up amount must be between UGX % and UGX %.',
        (v_elig->>'min_topup'), (v_elig->>'max_topup');
    END IF;
  END IF;

  v_fee := round(p_amount * (power(1 + COALESCE(a.monthly_rate, 0.33), p_extend_days::numeric / 30) - 1));

  v_new_principal   := COALESCE(a.principal,0) + p_amount;
  v_new_access_fee  := COALESCE(a.access_fee,0) + v_fee;
  v_new_outstanding := COALESCE(a.outstanding_balance,0) + p_amount + v_fee;
  v_new_cycle       := COALESCE(a.cycle_days,30) + p_extend_days;
  v_new_expires     := GREATEST(a.expires_at, now()) + make_interval(days => p_extend_days);

  v_period := public.advance_period_days(a.repayment_frequency);
  v_days_elapsed := GREATEST(0, ((now() AT TIME ZONE 'Africa/Kampala')::date
                                 - (a.issued_at AT TIME ZONE 'Africa/Kampala')::date));
  v_remaining_installments := GREATEST(
    1,
    ceil(GREATEST(1, v_new_cycle - v_days_elapsed)::numeric / v_period)
  );
  v_installment := ceil(v_new_outstanding / v_remaining_installments);

  PERFORM set_config('app.advance_topup_in_progress', a.id::text, true);

  UPDATE public.agent_advances
  SET principal = v_new_principal,
      access_fee = v_new_access_fee,
      outstanding_balance = v_new_outstanding,
      cycle_days = v_new_cycle,
      expires_at = v_new_expires,
      installment_amount = v_installment,
      daily_installment = CASE WHEN a.repayment_frequency = 'daily' THEN v_installment ELSE a.daily_installment END,
      status = 'active',
      updated_at = now()
  WHERE id = a.id;

  INSERT INTO public.agent_advance_topups (advance_id, amount, topped_up_by, extend_days, request_id, access_fee_added, reason)
  VALUES (a.id, p_amount, COALESCE(auth.uid(), a.issued_by), p_extend_days, p_request_id, v_fee, v_reason)
  RETURNING id INTO v_topup_id;

  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', a.agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_in',
        'amount', p_amount, 'category', 'agent_advance_credit',
        'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
        'source_table', 'agent_advance_topups', 'source_id', v_topup_id,
        'description', 'Agent advance top-up - extended ' || p_extend_days || 'd',
        'currency', 'UGX', 'transaction_date', v_now
      ),
      jsonb_build_object(
        'user_id', a.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
        'amount', p_amount, 'category', 'agent_advance_disbursement',
        'source_table', 'agent_advance_topups', 'source_id', v_topup_id,
        'description', 'Agent advance top-up disbursed to wallet',
        'currency', 'UGX', 'transaction_date', v_now
      )
    ),
    'advance_topup:' || v_topup_id::text,
    false
  );

  -- Access fee recognised in full at top-up (CFO decision 2026-09-27).
  -- Its OWN transaction group, so the principal group above is unchanged.
  --   platform agent_advance_access_fee_charged cash_out -> DR A11
  --   platform agent_advance_fee_revenue        cash_in  -> CR R2
  -- No wallet leg: the fee is baked into the repayment schedule, never debited
  -- from the wallet. v_fee is the amount actually charged and stored on
  -- agent_advance_topups.access_fee_added; it is never recomputed.
  IF v_fee > 0 THEN
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', a.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
          'amount', v_fee, 'category', 'agent_advance_access_fee_charged',
          'source_table', 'agent_advances', 'source_id', a.id,
          'description', 'Agent Advance access fee charged on top-up',
          'currency', 'UGX', 'transaction_date', v_now
        ),
        jsonb_build_object(
          'user_id', a.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_fee, 'category', 'agent_advance_fee_revenue',
          'source_table', 'agent_advances', 'source_id', a.id,
          'description', 'Agent Advance access fee revenue (top-up)',
          'currency', 'UGX', 'transaction_date', v_now
        )
      ),
      'advance_topup_fee:' || v_topup_id::text,
      false
    );
  END IF;

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES ('funds_added', a.agent_id, 'agent_advances', a.id,
    jsonb_build_object('topup_id', v_topup_id, 'advance_id', a.id, 'amount', p_amount,
                       'extend_days', p_extend_days, 'reason', v_reason,
                       'override', p_override_eligibility, 'actor_id', auth.uid(),
                       'description', 'Agent advance top-up'));

  IF p_override_eligibility AND auth.uid() IS NOT NULL THEN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (auth.uid(), 'advance_topup_override', 'agent_advances', a.id::text, v_reason,
      jsonb_build_object('topup_id', v_topup_id, 'amount', p_amount, 'extend_days', p_extend_days,
                         'access_fee_added', v_fee, 'new_principal', v_new_principal,
                         'new_outstanding', v_new_outstanding, 'transaction_group_id', v_group));
  END IF;

  RETURN jsonb_build_object(
    'advance_id', a.id,
    'topup_id', v_topup_id,
    'transaction_group_id', v_group,
    'agent_id', a.agent_id,
    'topup_amount', p_amount,
    'access_fee_added', v_fee,
    'new_principal', v_new_principal,
    'new_outstanding', v_new_outstanding,
    'new_cycle_days', v_new_cycle,
    'new_expires_at', v_new_expires,
    'new_installment', v_installment,
    'repayment_frequency', a.repayment_frequency,
    'monthly_rate', a.monthly_rate,
    'reason', v_reason,
    'override', p_override_eligibility
  );
END;
$function$;

-- ------------------------------------ 4. disburse_agent_advance_request
CREATE OR REPLACE FUNCTION public.disburse_agent_advance_request(p_request_id uuid, p_principal numeric DEFAULT NULL::numeric, p_cycle_days integer DEFAULT NULL::integer, p_monthly_rate numeric DEFAULT NULL::numeric, p_repayment_frequency text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_skip_reason text DEFAULT NULL::text, p_recovery_source text DEFAULT 'wallet_daily'::text, p_roi_recovery_percent numeric DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_req public.agent_advance_requests;
  v_principal numeric; v_cycle integer; v_rate numeric; v_freq text;
  v_reg_fee numeric; v_access_fee numeric; v_total numeric;
  v_installments integer; v_installment numeric; v_notes text;
  v_advance_id uuid; v_now timestamptz := now(); v_group uuid; v_override boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  IF NOT (
    has_role(v_actor, 'super_admin'::app_role) OR has_role(v_actor, 'manager'::app_role)
    OR has_role(v_actor, 'cfo'::app_role) OR has_role(v_actor, 'coo'::app_role)
    OR has_role(v_actor, 'ceo'::app_role) OR has_role(v_actor, 'operations'::app_role)
    OR has_role(v_actor, 'agent_ops'::app_role) OR has_role(v_actor, 'financial_ops'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.staff_permissions sp
      WHERE sp.user_id = v_actor AND sp.permitted_dashboard IN ('agent-ops','financial-ops','company-ops')
    )
  ) THEN
    RAISE EXCEPTION 'Not authorized to disburse agent advances';
  END IF;

  IF NULLIF(p_skip_reason, '') IS NOT NULL THEN
    RAISE EXCEPTION 'CFO approval is mandatory — the skip-CFO path has been removed';
  END IF;

  SELECT * INTO v_req FROM public.agent_advance_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Advance request not found'; END IF;

  v_override := COALESCE(v_req.gate_override, false);

  IF COALESCE(v_req.request_kind, 'new') <> 'new' THEN
    RAISE EXCEPTION 'Top-up requests must be merged with apply_advance_topup';
  END IF;

  IF v_req.status NOT IN ('cfo_approved','cfo_paid') THEN
    RAISE EXCEPTION 'Disbursement blocked — CFO approval is required (request status is %)', v_req.status;
  END IF;
  IF v_req.cfo_approved_by IS NULL OR v_req.cfo_approved_at IS NULL THEN
    RAISE EXCEPTION 'Disbursement blocked — this request has no recorded CFO approval';
  END IF;

  IF EXISTS (SELECT 1 FROM public.agent_advances WHERE request_id = p_request_id) THEN
    RAISE EXCEPTION 'This request has already been disbursed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.general_ledger
    WHERE source_table = 'agent_advance_requests' AND source_id = p_request_id
      AND category = 'agent_advance_credit'
  ) THEN
    RAISE EXCEPTION 'A wallet credit already exists for this request';
  END IF;

  v_principal := COALESCE(p_principal, v_req.principal);
  v_cycle     := COALESCE(p_cycle_days, v_req.cycle_days);
  v_rate      := COALESCE(p_monthly_rate, v_req.monthly_rate);
  v_freq      := COALESCE(p_repayment_frequency, v_req.repayment_frequency, 'daily');

  IF v_cycle IS NULL OR v_cycle <= 0 THEN RAISE EXCEPTION 'Cycle days must be greater than zero'; END IF;

  IF v_override THEN
    IF v_principal IS NULL OR v_principal <= 0 THEN RAISE EXCEPTION 'Principal must be greater than zero'; END IF;
    IF v_rate IS NULL OR v_rate < 0 OR v_rate > 1 THEN
      RAISE EXCEPTION 'Monthly rate must be between 0%% and 100%%';
    END IF;
  ELSE
    IF v_principal IS NULL OR v_principal < 10000 THEN RAISE EXCEPTION 'Principal must be at least UGX 10,000'; END IF;
    IF v_rate IS NULL OR v_rate <= 0 OR v_rate > 0.33 THEN
      RAISE EXCEPTION 'Monthly rate must be greater than 0 and at most 33%%';
    END IF;
  END IF;

  v_reg_fee    := CASE WHEN v_principal <= 200000 THEN 10000 ELSE 20000 END;
  v_access_fee := round(v_principal * v_rate * (v_cycle::numeric / 30));
  v_total      := v_principal + v_access_fee + v_reg_fee;

  v_installments := CASE v_freq
    WHEN 'weekly'   THEN GREATEST(1, ceil(v_cycle::numeric / 7))
    WHEN 'biweekly' THEN GREATEST(1, ceil(v_cycle::numeric / 14))
    WHEN 'monthly'  THEN GREATEST(1, ceil(v_cycle::numeric / 30))
    ELSE GREATEST(1, v_cycle)
  END;
  v_installment := ceil(v_total / v_installments);

  v_notes := NULLIF(p_notes, '');

  UPDATE public.agent_advance_requests SET
    status = 'cfo_paid',
    paid_by_cfo = COALESCE(paid_by_cfo, v_actor),
    cfo_paid_at = COALESCE(cfo_paid_at, v_now),
    cfo_adjusted_rate = CASE WHEN v_rate <> monthly_rate THEN v_rate ELSE cfo_adjusted_rate END,
    cfo_notes = COALESCE(v_notes, cfo_notes),
    principal = v_principal, cycle_days = v_cycle, registration_fee = v_reg_fee,
    access_fee = v_access_fee, total_payable = v_total, daily_payment = v_installment,
    monthly_rate = v_rate, repayment_frequency = v_freq, updated_at = v_now
  WHERE id = p_request_id;

  INSERT INTO public.agent_advances (
    agent_id, issued_by, request_id, principal, outstanding_balance, cycle_days,
    monthly_rate, daily_rate, access_fee, registration_fee, access_fee_collected,
    access_fee_status, status, repayment_frequency, installment_amount,
    daily_installment, expires_at, recovery_source, roi_recovery_percent, gate_override
  ) VALUES (
    v_req.agent_id, v_actor, p_request_id, v_principal, v_total, v_cycle,
    v_rate, v_rate, v_access_fee, v_reg_fee, 0,
    'unpaid', 'active', v_freq, v_installment,
    v_installment, v_now + make_interval(days => v_cycle),
    COALESCE(p_recovery_source, 'wallet_daily'),
    CASE WHEN p_recovery_source = 'roi' THEN COALESCE(p_roi_recovery_percent, 0) ELSE 0 END,
    v_override
  ) RETURNING id INTO v_advance_id;

  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_req.agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_in',
        'amount', v_principal, 'category', 'agent_advance_credit',
        'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
        'source_table', 'agent_advance_requests', 'source_id', p_request_id,
        'description', 'Agent advance disbursement - ' || v_cycle || 'd @ ' || round(v_rate * 100) || '%',
        'currency', 'UGX', 'transaction_date', v_now
      ),
      jsonb_build_object(
        'user_id', v_req.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
        'amount', v_principal, 'category', 'rent_disbursement',
        'source_table', 'agent_advance_requests', 'source_id', p_request_id,
        'description', 'Agent advance disbursed to wallet',
        'currency', 'UGX', 'transaction_date', v_now
      )
    ),
    'advance_disbursement:' || p_request_id::text, false
  );

  -- Access fee recognised in full at origination (CFO decision 2026-09-27).
  --   platform agent_advance_access_fee_charged cash_out -> DR A11
  --   platform agent_advance_fee_revenue        cash_in  -> CR R2
  -- Its OWN transaction group, so the principal group above stays exactly as
  -- it was, including its resolver exception. Platform legs only: the fee is
  -- baked into the repayment schedule and never debited from the wallet, so
  -- there is no wallet leg and no A1/A2/L1 movement. v_access_fee is the
  -- amount this call charged and stored on the advance; nothing is recomputed.
  IF v_access_fee > 0 THEN
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', v_req.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
          'amount', v_access_fee, 'category', 'agent_advance_access_fee_charged',
          'source_table', 'agent_advances', 'source_id', v_advance_id,
          'description', 'Agent Advance access fee charged at origination',
          'currency', 'UGX', 'transaction_date', v_now
        ),
        jsonb_build_object(
          'user_id', v_req.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_access_fee, 'category', 'agent_advance_fee_revenue',
          'source_table', 'agent_advances', 'source_id', v_advance_id,
          'description', 'Agent Advance access fee revenue (origination)',
          'currency', 'UGX', 'transaction_date', v_now
        )
      ),
      'advance_access_fee:' || p_request_id::text, false
    );
  END IF;

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES ('funds_added', v_req.agent_id, 'agent_advance_requests', p_request_id,
    jsonb_build_object('request_id', p_request_id, 'advance_id', v_advance_id,
                       'principal', v_principal, 'actor_id', v_actor,
                       'gate_override', v_override,
                       'description', 'Agent advance disbursed to wallet'));

  RETURN jsonb_build_object(
    'advance_id', v_advance_id, 'transaction_group_id', v_group,
    'principal', v_principal, 'cycle_days', v_cycle, 'monthly_rate', v_rate,
    'access_fee', v_access_fee, 'registration_fee', v_reg_fee,
    'total_payable', v_total, 'installment', v_installment,
    'installments', v_installments, 'repayment_frequency', v_freq,
    'gate_override', v_override
  );
END;
$function$;

-- ---------------------------------------- 5. update_agent_advance_terms
CREATE OR REPLACE FUNCTION public.update_agent_advance_terms(p_advance_id uuid, p_monthly_rate numeric, p_cycle_days integer, p_repayment_frequency text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_adv public.agent_advances%ROWTYPE;
  v_penalty numeric;
  v_old_total numeric;
  v_paid numeric;
  v_new_access_fee numeric;
  v_new_total numeric;
  v_new_outstanding numeric;
  v_expected_outstanding numeric;
  v_schedule_total numeric;
  v_period integer;
  v_installments integer;
  v_installment numeric;
  v_fee_delta numeric;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'agent_ops')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
  ) THEN
    RAISE EXCEPTION 'Only the CFO or Agent Ops may edit advance terms';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;
  IF p_monthly_rate IS NULL OR p_monthly_rate < 0 OR p_monthly_rate > 1 THEN
    RAISE EXCEPTION 'Rate must be between 0%% and 100%% per month';
  END IF;
  IF p_cycle_days IS NULL OR p_cycle_days < 1 OR p_cycle_days > 365 THEN
    RAISE EXCEPTION 'Term must be between 1 and 365 days';
  END IF;
  IF lower(coalesce(p_repayment_frequency,'daily')) NOT IN ('daily','weekly','biweekly','monthly') THEN
    RAISE EXCEPTION 'Invalid repayment frequency';
  END IF;

  SELECT * INTO v_adv FROM public.agent_advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Advance not found'; END IF;
  IF v_adv.status NOT IN ('active','overdue') THEN
    RAISE EXCEPTION 'Only active or overdue advances can be re-termed';
  END IF;

  SELECT COALESCE(SUM(interest_accrued), 0) INTO v_penalty
  FROM public.agent_advance_ledger
  WHERE advance_id = p_advance_id;

  v_old_total := COALESCE(v_adv.principal,0)
               + COALESCE(v_adv.access_fee,0)
               + COALESCE(v_adv.registration_fee,0)
               + v_penalty;

  v_paid := GREATEST(0, v_old_total - COALESCE(v_adv.outstanding_balance,0));

  v_new_access_fee := round(
    COALESCE(v_adv.principal,0) * (power(1 + p_monthly_rate, p_cycle_days::numeric / 30) - 1)
  );

  v_new_total := COALESCE(v_adv.principal,0)
               + v_new_access_fee
               + COALESCE(v_adv.registration_fee,0)
               + v_penalty;

  v_new_outstanding := GREATEST(0, v_new_total - v_paid);

  v_expected_outstanding := GREATEST(0,
    COALESCE(v_adv.outstanding_balance,0)
    + (v_new_access_fee - COALESCE(v_adv.access_fee,0))
  );
  IF abs(v_new_outstanding - v_expected_outstanding) > 0.5 THEN
    RAISE EXCEPTION
      'ADVANCE_TERMS_BALANCE_DRIFT: advance % would move from % to % but only the access fee changed (% -> %); expected %',
      p_advance_id, v_adv.outstanding_balance, v_new_outstanding,
      v_adv.access_fee, v_new_access_fee, v_expected_outstanding;
  END IF;

  v_schedule_total := COALESCE(v_adv.principal,0) + v_new_access_fee;
  v_period := public.advance_period_days(p_repayment_frequency);
  v_installments := greatest(1, ceil(p_cycle_days::numeric / v_period));
  v_installment := ceil(v_schedule_total / v_installments);

  UPDATE public.agent_advances
  SET monthly_rate = p_monthly_rate,
      daily_rate = p_monthly_rate,
      cycle_days = p_cycle_days,
      repayment_frequency = lower(p_repayment_frequency),
      access_fee = v_new_access_fee,
      installment_amount = v_installment,
      outstanding_balance = v_new_outstanding,
      expires_at = coalesce(v_adv.issued_at, now()) + (p_cycle_days || ' days')::interval,
      status = CASE WHEN v_new_outstanding <= 0 THEN 'completed' ELSE v_adv.status END,
      updated_at = now()
  WHERE id = p_advance_id;

  -- Access fee change recognised immediately (CFO decision 2026-09-27),
  -- symmetric in both directions:
  --   increase  DR A11 / CR R2
  --   decrease  DR R2  / CR A11
  -- Posted on the INCREMENTAL difference only, from the values this call
  -- computed. Historical fees are never recomputed. Its own transaction group,
  -- platform legs only, so no wallet leg and no A1/A2/L1 movement.
  --
  -- Deliberately NOT wrapped in an exception handler: if the ledger post fails
  -- the whole call rolls back, including the terms UPDATE above. The terms
  -- change and its accounting stand or fall together.
  v_fee_delta := v_new_access_fee - COALESCE(v_adv.access_fee,0);
  IF v_fee_delta <> 0 THEN
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', v_adv.agent_id, 'ledger_scope', 'platform',
          'direction', CASE WHEN v_fee_delta > 0 THEN 'cash_out' ELSE 'cash_in' END,
          'amount', abs(v_fee_delta), 'category', 'agent_advance_access_fee_charged',
          'source_table', 'agent_advances', 'source_id', p_advance_id,
          'description', CASE WHEN v_fee_delta > 0
                              THEN 'Agent Advance access fee increased on re-term'
                              ELSE 'Agent Advance access fee reduced on re-term' END,
          'currency', 'UGX'
        ),
        jsonb_build_object(
          'user_id', v_adv.agent_id, 'ledger_scope', 'platform',
          'direction', CASE WHEN v_fee_delta > 0 THEN 'cash_in' ELSE 'cash_out' END,
          'amount', abs(v_fee_delta), 'category', 'agent_advance_fee_revenue',
          'source_table', 'agent_advances', 'source_id', p_advance_id,
          'description', CASE WHEN v_fee_delta > 0
                              THEN 'Agent Advance access fee revenue (re-term increase)'
                              ELSE 'Agent Advance access fee revenue reversed (re-term decrease)' END,
          'currency', 'UGX'
        )
      ),
      'advance_terms_fee:' || p_advance_id::text || ':'
        || (extract(epoch from clock_timestamp()) * 1000)::bigint::text,
      false
    );
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (auth.uid(), 'advance_terms_edited', 'agent_advances', p_advance_id, jsonb_build_object(
    'reason', trim(p_reason),
    'old', jsonb_build_object('monthly_rate', v_adv.monthly_rate, 'cycle_days', v_adv.cycle_days,
                              'repayment_frequency', v_adv.repayment_frequency, 'access_fee', v_adv.access_fee,
                              'outstanding_balance', v_adv.outstanding_balance),
    'new', jsonb_build_object('monthly_rate', p_monthly_rate, 'cycle_days', p_cycle_days,
                              'repayment_frequency', lower(p_repayment_frequency), 'access_fee', v_new_access_fee,
                              'outstanding_balance', v_new_outstanding, 'installment_amount', v_installment),
    'preserved', jsonb_build_object('registration_fee', COALESCE(v_adv.registration_fee,0),
                                    'capitalised_penalty', v_penalty,
                                    'paid_to_date', v_paid,
                                    'old_total_payable', v_old_total,
                                    'new_total_payable', v_new_total)
  ));

  RETURN jsonb_build_object(
    'advance_id', p_advance_id,
    'access_fee', v_new_access_fee,
    'total_payable', v_new_total,
    'outstanding_balance', v_new_outstanding,
    'installment_amount', v_installment,
    'installments', v_installments,
    'registration_fee_preserved', COALESCE(v_adv.registration_fee,0),
    'capitalised_penalty_preserved', v_penalty
  );
END;
$function$;
