-- Rollback of 20261104230000_agent_advance_transfer_controls: the seven functions as in production on 2026-11-04 (verbatim), the new functions dropped, the cron
-- job removed. KEPT (data / audit): the new tables and columns, every transfer, write-off and reversal entry posted meanwhile, and
-- the widened cancellation_mode check (rows recorded as transfer / write_off_approved / payout_reversed stay valid).
SET lock_timeout = '5s';
CREATE OR REPLACE FUNCTION public.cancel_agent_advance(p_advance_id uuid, p_recoup boolean, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller UUID := auth.uid();
  v_adv RECORD;
  v_mode TEXT;
  v_prev_outstanding NUMERIC;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.can_act_pinned_finance_action(auth.uid()) THEN
    RAISE EXCEPTION 'Only the Chief Finance Officer or a designated super admin can do this.'
      USING ERRCODE = '42501';
  END IF;

  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (public.has_role(v_caller, 'cfo'::app_role)
       OR public.has_role(v_caller, 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO or Manager can cancel advances';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A cancellation reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_adv FROM public.agent_advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Advance not found';
  END IF;

  IF v_adv.status = 'cancelled' THEN
    RAISE EXCEPTION 'Advance already cancelled';
  END IF;
  IF v_adv.status = 'completed' THEN
    RAISE EXCEPTION 'Advance already completed';
  END IF;

  v_mode := CASE WHEN p_recoup THEN 'recoup_from_wallet' ELSE 'write_off' END;
  v_prev_outstanding := v_adv.outstanding_balance;

  IF p_recoup THEN
    -- Keep outstanding intact; CFO will record wallet recovery via existing
    -- "Record Payment" flow. Deductions still stop because status != active.
    UPDATE public.agent_advances SET
      status = 'cancelled',
      daily_installment = 0,
      cancelled_at = now(),
      cancelled_by = v_caller,
      cancellation_reason = p_reason,
      cancellation_mode = v_mode,
      pre_cancel_outstanding = v_prev_outstanding,
      updated_at = now()
    WHERE id = p_advance_id;
  ELSE
    -- Full write-off
    UPDATE public.agent_advances SET
      status = 'cancelled',
      outstanding_balance = 0,
      arrears_balance = 0,
      daily_installment = 0,
      cancelled_at = now(),
      cancelled_by = v_caller,
      cancellation_reason = p_reason,
      cancellation_mode = v_mode,
      pre_cancel_outstanding = v_prev_outstanding,
      updated_at = now()
    WHERE id = p_advance_id;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_caller,
    'agent_advance_cancelled',
    'agent_advances',
    p_advance_id,
    jsonb_build_object(
      'mode', v_mode,
      'reason', p_reason,
      'previous_outstanding', v_prev_outstanding,
      'agent_id', v_adv.agent_id,
      'principal', v_adv.principal
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'mode', v_mode,
    'previous_outstanding', v_prev_outstanding,
    'new_outstanding', CASE WHEN p_recoup THEN v_prev_outstanding ELSE 0 END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.cfo_create_advance(p_agent_id uuid, p_principal numeric, p_cycle_days integer, p_monthly_rate numeric, p_repayment_frequency text, p_reason text, p_override boolean DEFAULT false, p_override_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_now timestamptz := now();
  v_gates jsonb; v_gate_list text[];
  v_reg_fee numeric; v_access_fee numeric; v_total numeric;
  v_installments integer; v_installment numeric;
  v_freq text := COALESCE(NULLIF(btrim(COALESCE(p_repayment_frequency,'')), ''), 'daily');
  v_req public.agent_advance_requests;
BEGIN

  IF auth.uid() IS NOT NULL AND NOT public.is_cfo_approver(auth.uid()) THEN
    RAISE EXCEPTION 'This request could not be completed';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  IF NOT (
    has_role(v_actor, 'cfo'::app_role) OR has_role(v_actor, 'ceo'::app_role)
    OR has_role(v_actor, 'super_admin'::app_role) OR has_role(v_actor, 'admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized to initiate an advance';
  END IF;

  IF p_agent_id IS NULL THEN RAISE EXCEPTION 'An agent must be selected'; END IF;
  IF p_principal IS NULL OR p_principal <= 0 THEN RAISE EXCEPTION 'Principal must be greater than zero'; END IF;
  IF p_cycle_days IS NULL OR p_cycle_days <= 0 THEN RAISE EXCEPTION 'Cycle days must be greater than zero'; END IF;
  IF p_monthly_rate IS NULL OR p_monthly_rate < 0 OR p_monthly_rate > 1 THEN
    RAISE EXCEPTION 'Monthly rate must be between 0%% and 100%%';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 15 THEN
    RAISE EXCEPTION 'A reason of at least 15 characters is required';
  END IF;
  IF v_freq NOT IN ('daily','weekly','biweekly','monthly') THEN
    RAISE EXCEPTION 'Unknown repayment frequency: %', v_freq;
  END IF;
  IF p_override AND NULLIF(btrim(COALESCE(p_override_reason,'')), '') IS NULL THEN
    RAISE EXCEPTION 'ADVANCE_OVERRIDE_REASON_REQUIRED: state why the eligibility gates are being bypassed.';
  END IF;

  v_gates := public.agent_advance_blocking_gates(p_agent_id, p_principal, p_monthly_rate);
  SELECT array_agg(g) INTO v_gate_list FROM jsonb_array_elements_text(v_gates->'gates') g;

  v_reg_fee    := CASE WHEN p_principal <= 200000 THEN 10000 ELSE 20000 END;
  v_access_fee := round(p_principal * p_monthly_rate * (p_cycle_days::numeric / 30));
  v_total      := p_principal + v_access_fee + v_reg_fee;

  v_installments := CASE v_freq
    WHEN 'weekly'   THEN GREATEST(1, ceil(p_cycle_days::numeric / 7))
    WHEN 'biweekly' THEN GREATEST(1, ceil(p_cycle_days::numeric / 14))
    WHEN 'monthly'  THEN GREATEST(1, ceil(p_cycle_days::numeric / 30))
    ELSE GREATEST(1, p_cycle_days)
  END;
  v_installment := ceil(v_total / v_installments);

  INSERT INTO public.agent_advance_requests (
    agent_id, principal, cycle_days, monthly_rate, access_fee, registration_fee,
    total_payable, daily_payment, repayment_frequency, reason, status,
    cfo_approved_by, cfo_approved_at,
    gate_override, gate_override_by, gate_override_at, gate_override_reason, gate_override_gates
  ) VALUES (
    p_agent_id, p_principal, p_cycle_days, p_monthly_rate, v_access_fee, v_reg_fee,
    v_total, v_installment, v_freq, '[CFO-initiated] ' || btrim(p_reason), 'cfo_approved',
    v_actor, v_now,
    COALESCE(p_override, false),
    CASE WHEN p_override THEN v_actor END,
    CASE WHEN p_override THEN v_now END,
    CASE WHEN p_override THEN btrim(p_override_reason) END,
    CASE WHEN p_override THEN v_gate_list END
  ) RETURNING * INTO v_req;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (
    v_actor,
    CASE WHEN COALESCE(p_override, false) THEN 'cfo_advance_gate_override' ELSE 'cfo_initiated_advance' END,
    'agent_advance_requests', v_req.id::text,
    CASE WHEN COALESCE(p_override, false) THEN btrim(p_override_reason) ELSE btrim(p_reason) END,
    jsonb_build_object(
      'agent_id', p_agent_id, 'principal', p_principal, 'cycle_days', p_cycle_days,
      'monthly_rate', p_monthly_rate, 'repayment_frequency', v_freq,
      'access_fee', v_access_fee, 'registration_fee', v_reg_fee,
      'total_payable', v_total, 'installment', v_installment,
      'override', COALESCE(p_override, false), 'gates_at_issue', v_gates, 'reason', btrim(p_reason)
    )
  );

  RETURN jsonb_build_object(
    'request', to_jsonb(v_req), 'gates_at_issue', v_gates,
    'access_fee', v_access_fee, 'registration_fee', v_reg_fee,
    'total_payable', v_total, 'installment', v_installment, 'installments', v_installments
  );
END;
$function$;

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
  IF auth.uid() IS NOT NULL AND NOT public.can_act_pinned_finance_action(auth.uid()) THEN
    RAISE EXCEPTION 'Only the Chief Finance Officer or a designated super admin can do this.'
      USING ERRCODE = '42501';
  END IF;

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
        'amount', v_principal, 'category', 'agent_advance_disbursement',
        'source_table', 'agent_advances', 'source_id', v_advance_id,
        'description', 'Agent advance disbursed to wallet',
        'currency', 'UGX', 'transaction_date', v_now
      )
    ),
    'advance_disbursement:' || p_request_id::text, false
  );
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
  IF v_reg_fee > 0 THEN
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', v_req.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
          'amount', v_reg_fee, 'category', 'agent_advance_registration_fee_charged',
          'source_table', 'agent_advances', 'source_id', v_advance_id,
          'description', 'Agent Advance registration fee charged at origination',
          'currency', 'UGX', 'transaction_date', v_now
        ),
        jsonb_build_object(
          'user_id', v_req.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_reg_fee, 'category', 'agent_advance_fee_revenue',
          'source_table', 'agent_advances', 'source_id', v_advance_id,
          'description', 'Agent Advance registration fee revenue (origination)',
          'currency', 'UGX', 'transaction_date', v_now
        )
      ),
      'advance_registration_fee:' || p_request_id::text, false
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
  IF auth.uid() IS NOT NULL AND NOT public.can_act_pinned_finance_action(auth.uid()) THEN
    RAISE EXCEPTION 'Only the Chief Finance Officer or a designated super admin can do this.'
      USING ERRCODE = '42501';
  END IF;

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
        'source_table', 'agent_advances', 'source_id', a.id,
        'description', 'Agent advance top-up disbursed to wallet',
        'currency', 'UGX', 'transaction_date', v_now
      )
    ),
    'advance_topup:' || v_topup_id::text,
    false
  );
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

CREATE OR REPLACE FUNCTION public.cfo_record_advance_payment(p_advance_id uuid, p_amount numeric, p_payment_method text, p_reference text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller         uuid := auth.uid();
  v_adv            RECORD;
  v_today          date;
  v_opening        numeric;
  v_paid           numeric;
  v_closing        numeric;
  v_new_status     text;
  v_total_payable  numeric;
  v_total_deducted numeric;
  v_fee_ratio      numeric;
  v_new_fee        numeric;
  v_fee_status     text;
  v_group_id       uuid;
  v_idem           text;
  v_description    text;
  v_entries        jsonb;
  v_recv_category  text;
  v_alloc          jsonb;
  v_funding        jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_act_pinned_finance_action(v_caller) THEN
    RAISE EXCEPTION 'Only the Chief Finance Officer or a designated super admin can record advance payments'
      USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'A positive amount is required' USING ERRCODE = '22023';
  END IF;
  IF p_reference IS NULL OR length(trim(p_reference)) = 0 THEN
    RAISE EXCEPTION 'A payment reference is required' USING ERRCODE = '22023';
  END IF;
  IF p_payment_method IS NULL OR length(trim(p_payment_method)) = 0 THEN
    RAISE EXCEPTION 'A payment method is required' USING ERRCODE = '22023';
  END IF;
  IF p_payment_method NOT IN ('wallet_offset', 'mobile_money', 'bank_transfer', 'cash') THEN
    RAISE EXCEPTION
      'Unsupported payment_method %. Supported: wallet_offset, mobile_money, bank_transfer, cash. The payment has NOT been recorded.', p_payment_method
      USING ERRCODE = '0A000';
  END IF;
  SELECT * INTO v_adv FROM public.agent_advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Advance not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_adv.status = 'completed' THEN
    RAISE EXCEPTION 'Advance already completed' USING ERRCODE = '22023';
  END IF;
  IF v_adv.status = 'cancelled' THEN
    RAISE EXCEPTION 'Advance already cancelled' USING ERRCODE = '22023';
  END IF;
  v_today   := (now() AT TIME ZONE 'UTC')::date;
  v_opening := COALESCE(v_adv.outstanding_balance, 0);
  v_paid    := LEAST(p_amount, v_opening);
  v_closing := GREATEST(0, v_opening - v_paid);
  IF v_paid <= 0 THEN
    RAISE EXCEPTION 'Nothing to collect: outstanding balance is %', v_opening
      USING ERRCODE = '22023';
  END IF;
  v_new_status := CASE
    WHEN v_closing <= 0 THEN 'completed'
    WHEN v_adv.expires_at < now() THEN 'overdue'
    ELSE 'active'
  END;
  v_total_payable  := COALESCE(v_adv.principal, 0) + COALESCE(v_adv.access_fee, 0);
  v_total_deducted := v_total_payable - v_closing;
  v_fee_ratio      := CASE
    WHEN v_total_payable > 0
      THEN GREATEST(0, LEAST(1, v_total_deducted / v_total_payable))
    ELSE 0
  END;
  v_new_fee    := round(COALESCE(v_adv.access_fee, 0) * v_fee_ratio);
  v_fee_status := CASE
    WHEN v_new_fee >= COALESCE(v_adv.access_fee, 0) THEN 'settled'
    WHEN v_new_fee > 0 THEN 'partial'
    ELSE 'unpaid'
  END;
  v_idem := 'cfo_adv_pay_' || p_advance_id::text || '_'
            || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;
  v_description := 'CFO-recorded advance payment - ref ' || trim(p_reference)
                   || ' - ' || p_payment_method
                   || COALESCE(' - ' || nullif(trim(p_notes), ''), '');
  IF p_payment_method = 'wallet_offset' THEN
    v_funding := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_adv.agent_id, 'ledger_scope', 'wallet',
        'direction', 'cash_out', 'amount', v_paid,
        'category', 'agent_repayment', 'recipient_type', 'user',
        'source_table', 'agent_advances', 'source_id', p_advance_id,
        'description', v_description, 'currency', 'UGX',
        'transaction_date', v_today
      ));
    v_alloc := public.agent_advance_allocation_entries(
                 p_advance_id, v_adv.agent_id, v_paid, v_today::timestamptz, false);
    IF v_alloc IS NULL THEN
      v_entries := v_funding || jsonb_build_array(
      jsonb_build_object(
        'user_id', v_adv.agent_id, 'ledger_scope', 'platform',
        'direction', 'cash_in', 'amount', v_paid,
        'category', 'agent_repayment', 'recipient_type', 'operational_wallet',
        'source_table', 'agent_advances', 'source_id', p_advance_id,
        'description', v_description, 'currency', 'UGX',
        'transaction_date', v_today
      ));
    ELSE
      v_entries := v_funding || v_alloc;
    END IF;
  ELSE
    v_recv_category := CASE
      WHEN p_payment_method = 'cash' THEN 'cash_receipt_in_transit'
      ELSE 'agent_advance_receipt_bank'
    END;
    v_entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_adv.agent_id, 'ledger_scope', 'platform',
        'direction', 'cash_in', 'amount', v_paid,
        'category', v_recv_category, 'recipient_type', 'operational_wallet',
        'source_table', 'agent_advances', 'source_id', p_advance_id,
        'description', v_description, 'currency', 'UGX',
        'transaction_date', v_today
      ),
      jsonb_build_object(
        'user_id', v_adv.agent_id, 'ledger_scope', 'platform',
        'direction', 'cash_out', 'amount', v_paid,
        'category', 'agent_advance_repayment_external',
        'recipient_type', 'operational_wallet',
        'source_table', 'agent_advances', 'source_id', p_advance_id,
        'description', v_description, 'currency', 'UGX',
        'transaction_date', v_today
      )
    );
  END IF;
  SELECT public.create_ledger_transaction(
    entries         => v_entries,
    idempotency_key => v_idem
  ) INTO v_group_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'Ledger posting returned no transaction group; aborting'
      USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.agent_advance_ledger
    (advance_id, date, opening_balance, interest_accrued, amount_deducted,
     closing_balance, deduction_status, recovery_source, ledger_group_id, note)
  VALUES
    (p_advance_id, v_today, v_opening, 0, v_paid, v_closing,
     CASE WHEN v_closing <= 0 THEN 'full' ELSE 'partial' END,
     CASE WHEN p_payment_method = 'wallet_offset' THEN 'wallet_offset'
          ELSE 'external_' || coalesce(nullif(p_payment_method, ''), 'bank') END,
     CASE WHEN p_payment_method = 'wallet_offset' THEN NULL ELSE v_group_id END,
     left('CFO recorded payment, ref ' || coalesce(nullif(trim(p_reference), ''), '(none)')
          || coalesce(' - ' || nullif(trim(p_notes), ''), ''), 500));
  UPDATE public.agent_advances SET
    outstanding_balance  = v_closing,
    status               = v_new_status,
    access_fee_collected = v_new_fee,
    access_fee_status    = v_fee_status,
    updated_at           = now()
  WHERE id = p_advance_id;
  INSERT INTO public.audit_logs
    (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (
    v_caller,
    'cfo_advance_payment_recorded',
    'agent_advances',
    p_advance_id,
    left(COALESCE(nullif(trim(p_notes), ''), 'manual payment ' || trim(p_reference)), 200),
    jsonb_build_object(
      'amount',               v_paid,
      'payment_method',       p_payment_method,
      'reference',            trim(p_reference),
      'opening_balance',      v_opening,
      'closing_balance',      v_closing,
      'new_status',           v_new_status,
      'transaction_group_id', v_group_id,
      'receiving_account',    CASE
                                WHEN p_payment_method = 'wallet_offset' THEN 'L1'
                                WHEN p_payment_method = 'cash' THEN 'A5'
                                ELSE 'A1' END,
      'posted_atomically',    true
    )
  );
  RETURN jsonb_build_object(
    'success',              true,
    'amount',               v_paid,
    'payment_method',       p_payment_method,
    'opening_balance',      v_opening,
    'closing_balance',      v_closing,
    'new_status',           v_new_status,
    'transaction_group_id', v_group_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_cfo_paid_by_category_totals(p_from date, p_to date)
 RETURNS TABLE(category_key text, category_label text, sort_order integer, amount numeric, tx_count bigint, pct numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz; v_to timestamptz;
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN
    RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023';
  END IF;
  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');

  RETURN QUERY
  WITH cm AS MATERIALIZED (
    SELECT x.c, CASE WHEN x.c = 'agent_advance_disbursement' THEN 'agent' ELSE public._cfo_paid_category_for(x.c) END AS k
    FROM (SELECT DISTINCT g0.category AS c FROM public.general_ledger g0
          WHERE g0.direction = 'cash_out' AND g0.transaction_date >= v_from AND g0.transaction_date < v_to) x
  ), legs AS (
    SELECT CASE WHEN g.classification = 'admin_correction' OR (g.category = 'payroll_expense' AND g.ledger_scope = 'platform' AND g.description ILIKE '%lunch allowance%') THEN 'operational'
                WHEN g.ledger_scope = 'platform' AND g.reference_id IN (
                  SELECT sr.wallet_transaction_id::text FROM public.staff_requisitions sr WHERE sr.wallet_credit_status = 'credited' AND sr.wallet_transaction_id IS NOT NULL AND lower(btrim(sr.department_key)) = 'marketing'
                  UNION ALL
                  SELECT er.wallet_transaction_id::text FROM public.employee_requisitions er WHERE er.wallet_credit_status = 'credited' AND er.wallet_transaction_id IS NOT NULL AND lower(btrim(er.department)) IN ('marketing','marketing department')) THEN 'marketing'
                WHEN g.category = 'marketing_expense' AND g.ledger_scope = 'platform'
                     AND (g.description LIKE 'Marketing expense: Promissory partner top-up commission%'
                          OR g.description LIKE 'Marketing expense: Promissory partner portfolio commission%'
                          OR g.description LIKE 'Marketing expense: Verified promissory note bonus%'
                          OR g.description = 'Marketing expense: lead partner growth override'
                          OR g.description LIKE 'Marketing expense: Managed proxy portfolio activation commission%'
                          OR g.description LIKE 'Marketing expense: Managed proxy portfolio top-up commission%'
                          OR g.description LIKE 'Marketing expense: Partner first fund-in commission%'
                          OR g.description LIKE 'Marketing expense: Partner repeat fund-in commission%') THEN 'partner'
                WHEN g.category = 'marketing_expense' AND g.ledger_scope = 'platform'
                     AND (g.description LIKE 'Platform expense: instant house-listed reward%'
                          OR g.description LIKE 'Platform expense: listing reward%'
                          OR g.description LIKE '%recruiter override%'
                          OR g.description LIKE 'Marketing expense: Bonus:%'
                          OR g.description LIKE '%verified bonus%'
                          OR g.description LIKE '%verification bonus%'
                          OR g.description LIKE 'Marketing expense: listing bonus%'
                          OR g.description LIKE '%registration bonus%'
                          OR g.description LIKE '%registration verification bo%'
                          OR g.description LIKE 'Platform expense: instant LC%-registration reward%'
                          OR g.description LIKE 'Marketing expense: Weekly Collection Streak reward%'
                          OR g.description LIKE '%agent commission for landlord payout%'
                          OR g.description LIKE 'Commission restore offset%'
                          OR g.description LIKE 'Marketing expense: commission correction%'
                          OR g.description LIKE 'Marketing expense: agent commission backfill%'
                          OR g.description LIKE 'Marketing expense: Manager agent commission%'
                          OR g.description LIKE 'Marketing expense: Sub-agent tenant reward%'
                          OR g.description LIKE 'Merchant Agent Referral Bonus%'
                          OR (g.description LIKE 'Referral%'
                              AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = g.user_id AND ur.role = 'agent'))
                          OR (g.description LIKE 'Marketing expense: Invite reward%'
                              AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = g.user_id AND ur.role = 'agent'))) THEN 'agent'
                WHEN g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
                     AND g.description LIKE 'Agent advance%disbursed to wallet%' THEN 'agent'
                WHEN g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
                     AND g.description LIKE 'Partner self-managed funding released to agent landlord float%' THEN 'partner'
                WHEN g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
                     AND g.description LIKE 'Undo of double-reversal:%' THEN 'corrections'
                ELSE CASE WHEN cm.k = 'budget' THEN 'operational' ELSE cm.k END END AS cat_key, g.amount
    FROM public.general_ledger g
    LEFT JOIN cm ON cm.c = g.category
    WHERE g.direction = 'cash_out'
      AND (g.classification IN ('production', 'legacy_real')
           OR (g.classification = 'admin_correction' AND g.category = 'system_balance_correction'
               AND g.ledger_scope = 'platform' AND g.description ILIKE '%automated%lunch allowance%'
               AND public._cfo_paid_lunch_correction_ok(g.id, g.transaction_group_id, g.amount, g.transaction_date)))
      AND g.transaction_date >= v_from AND g.transaction_date < v_to
      AND g.category <> 'listing_rejection_recovery'
  ), grand AS (SELECT coalesce(sum(l2.amount),0)::numeric AS total FROM legs l2)
  SELECT f.category_key, f.category_label, f.sort_order,
         coalesce(l.amount, 0)::numeric AS amount,
         coalesce(l.tx_count, 0)::bigint AS tx_count,
         CASE WHEN gr.total > 0 THEN round(coalesce(l.amount,0) * 100.0 / gr.total, 2) ELSE 0 END AS pct
  FROM (VALUES
    ('agent', 'Agent Products and Services', 2),
    ('landlord', 'Landlord Products and Services', 3),
    ('tenant', 'Tenant Products and Services', 4),
    ('partner', 'Partnership Products and Services', 5),
    ('operational', 'Operational Expenses', 6),
    ('marketing', 'Marketing Expenses', 7),
    ('rnd', 'Product Research & Development', 8),
    ('corrections', 'Corrections', 9)
  ) AS f(category_key, category_label, sort_order)
  LEFT JOIN (SELECT cl.cat_key, sum(cl.amount) AS amount, count(*) AS tx_count FROM legs cl WHERE cl.cat_key IS NOT NULL GROUP BY cl.cat_key) l
    ON l.cat_key = f.category_key
  CROSS JOIN grand gr
  ORDER BY f.sort_order;
END
$function$;

CREATE OR REPLACE FUNCTION public.get_cfo_paid_by_category_page(p_from date, p_to date, p_category text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_offset integer DEFAULT 0, p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, transaction_date timestamp with time zone, created_at timestamp with time zone, category_key text, category_label text, ledger_category text, amount numeric, description text, reference_id text, counterparty text, counterparty_phone text, approved_by text, source_table text, transaction_group_id uuid, classification text, total_matched bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz; v_to timestamptz;
  v_search text := nullif(btrim(p_search), '');
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN
    RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023';
  END IF;
  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');

  RETURN QUERY
  WITH cm AS MATERIALIZED (
    SELECT x.c, CASE WHEN x.c = 'agent_advance_disbursement' THEN 'agent' ELSE public._cfo_paid_category_for(x.c) END AS k
    FROM (SELECT DISTINCT g0.category AS c FROM public.general_ledger g0
          WHERE g0.direction = 'cash_out' AND g0.transaction_date >= v_from AND g0.transaction_date < v_to) x
  ), f AS (
    SELECT g.id AS gid, g.transaction_date AS tdate,
           CASE WHEN g.classification = 'admin_correction' OR (g.category = 'payroll_expense' AND g.ledger_scope = 'platform' AND g.description ILIKE '%lunch allowance%') THEN 'operational'
                WHEN g.ledger_scope = 'platform' AND g.reference_id IN (
                  SELECT sr.wallet_transaction_id::text FROM public.staff_requisitions sr WHERE sr.wallet_credit_status = 'credited' AND sr.wallet_transaction_id IS NOT NULL AND lower(btrim(sr.department_key)) = 'marketing'
                  UNION ALL
                  SELECT er.wallet_transaction_id::text FROM public.employee_requisitions er WHERE er.wallet_credit_status = 'credited' AND er.wallet_transaction_id IS NOT NULL AND lower(btrim(er.department)) IN ('marketing','marketing department')) THEN 'marketing'
                WHEN g.category = 'marketing_expense' AND g.ledger_scope = 'platform'
                     AND (g.description LIKE 'Marketing expense: Promissory partner top-up commission%'
                          OR g.description LIKE 'Marketing expense: Promissory partner portfolio commission%'
                          OR g.description LIKE 'Marketing expense: Verified promissory note bonus%'
                          OR g.description = 'Marketing expense: lead partner growth override'
                          OR g.description LIKE 'Marketing expense: Managed proxy portfolio activation commission%'
                          OR g.description LIKE 'Marketing expense: Managed proxy portfolio top-up commission%'
                          OR g.description LIKE 'Marketing expense: Partner first fund-in commission%'
                          OR g.description LIKE 'Marketing expense: Partner repeat fund-in commission%') THEN 'partner'
                WHEN g.category = 'marketing_expense' AND g.ledger_scope = 'platform'
                     AND (g.description LIKE 'Platform expense: instant house-listed reward%'
                          OR g.description LIKE 'Platform expense: listing reward%'
                          OR g.description LIKE '%recruiter override%'
                          OR g.description LIKE 'Marketing expense: Bonus:%'
                          OR g.description LIKE '%verified bonus%'
                          OR g.description LIKE '%verification bonus%'
                          OR g.description LIKE 'Marketing expense: listing bonus%'
                          OR g.description LIKE '%registration bonus%'
                          OR g.description LIKE '%registration verification bo%'
                          OR g.description LIKE 'Platform expense: instant LC%-registration reward%'
                          OR g.description LIKE 'Marketing expense: Weekly Collection Streak reward%'
                          OR g.description LIKE '%agent commission for landlord payout%'
                          OR g.description LIKE 'Commission restore offset%'
                          OR g.description LIKE 'Marketing expense: commission correction%'
                          OR g.description LIKE 'Marketing expense: agent commission backfill%'
                          OR g.description LIKE 'Marketing expense: Manager agent commission%'
                          OR g.description LIKE 'Marketing expense: Sub-agent tenant reward%'
                          OR g.description LIKE 'Merchant Agent Referral Bonus%'
                          OR (g.description LIKE 'Referral%'
                              AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = g.user_id AND ur.role = 'agent'))
                          OR (g.description LIKE 'Marketing expense: Invite reward%'
                              AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = g.user_id AND ur.role = 'agent'))) THEN 'agent'
                WHEN g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
                     AND g.description LIKE 'Agent advance%disbursed to wallet%' THEN 'agent'
                WHEN g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
                     AND g.description LIKE 'Partner self-managed funding released to agent landlord float%' THEN 'partner'
                WHEN g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
                     AND g.description LIKE 'Undo of double-reversal:%' THEN 'corrections'
                ELSE CASE WHEN cm.k = 'budget' THEN 'operational' ELSE cm.k END END AS ckey
    FROM public.general_ledger g
    LEFT JOIN public.profiles sp ON v_search IS NOT NULL AND sp.id = g.user_id
    LEFT JOIN cm ON cm.c = g.category
    WHERE g.direction = 'cash_out'
      AND (g.classification IN ('production', 'legacy_real')
           OR (g.classification = 'admin_correction' AND g.category = 'system_balance_correction'
               AND g.ledger_scope = 'platform' AND g.description ILIKE '%automated%lunch allowance%'
               AND public._cfo_paid_lunch_correction_ok(g.id, g.transaction_group_id, g.amount, g.transaction_date)))
      AND g.transaction_date >= v_from AND g.transaction_date < v_to
      AND g.category <> 'listing_rejection_recovery'
      AND (v_search IS NULL OR g.description ILIKE '%' || v_search || '%'
           OR g.reference_id ILIKE '%' || v_search || '%'
           OR sp.full_name ILIKE '%' || v_search || '%')
  ), pg AS (
    SELECT f.gid, f.tdate, f.ckey, count(*) OVER () AS n
    FROM f
    WHERE (p_category IS NULL OR f.ckey = p_category)
    ORDER BY f.tdate DESC, f.gid
    OFFSET p_offset LIMIT p_limit
  )
  SELECT g.id, g.transaction_date, g.created_at, pg.ckey,
         CASE pg.ckey WHEN 'agent' THEN 'Agent Products and Services'
                      WHEN 'landlord' THEN 'Landlord Products and Services'
                      WHEN 'tenant' THEN 'Tenant Products and Services'
                      WHEN 'partner' THEN 'Partnership Products and Services'
                      WHEN 'marketing' THEN 'Marketing Expenses'
                      WHEN 'operational' THEN 'Operational Expenses'
                      WHEN 'budget' THEN 'Budget Expenses'
                      WHEN 'rnd' THEN 'Product Research & Development'
                      WHEN 'corrections' THEN 'Corrections'
                      ELSE pg.ckey END,
         g.category, g.amount, g.description, g.reference_id,
         CASE WHEN cpl.user_id IS NOT NULL AND cpl.user_id IS DISTINCT FROM g.user_id THEN cp.full_name ELSE p.full_name END,
         CASE WHEN cpl.user_id IS NOT NULL AND cpl.user_id IS DISTINCT FROM g.user_id THEN cp.phone ELSE p.phone END,
         CASE WHEN cpl.user_id IS NOT NULL AND cpl.user_id IS DISTINCT FROM g.user_id THEN p.full_name END,
         g.source_table, g.transaction_group_id, g.classification, pg.n
  FROM pg JOIN public.general_ledger g ON g.id = pg.gid
  LEFT JOIN LATERAL (
    SELECT x.user_id FROM public.general_ledger x
    WHERE x.transaction_group_id = g.transaction_group_id
      AND x.ledger_scope = 'wallet' AND x.direction = 'cash_in' AND x.user_id IS NOT NULL
    ORDER BY x.amount DESC, x.id
    LIMIT 1
  ) cpl ON true
  LEFT JOIN public.profiles cp ON cp.id = cpl.user_id
  LEFT JOIN public.profiles p ON p.id = g.user_id
  ORDER BY pg.tdate DESC, pg.gid;
END
$function$;


DROP FUNCTION IF EXISTS public.cfo_transfer_agent_advance(uuid, text, text, text, uuid, numeric, uuid, text, numeric, integer, text);
DROP FUNCTION IF EXISTS public.request_agent_advance_write_off(uuid, text);
DROP FUNCTION IF EXISTS public.decide_agent_advance_write_off(uuid, boolean, text);
DROP FUNCTION IF EXISTS public._agent_advance_post_write_off(uuid, uuid);
DROP FUNCTION IF EXISTS public.reserve_wallet_reversal(uuid, uuid, numeric, text, uuid);
DROP FUNCTION IF EXISTS public.settle_wallet_reversal(uuid, uuid);
DROP FUNCTION IF EXISTS public.run_agent_advance_reconciliation();
DROP FUNCTION IF EXISTS public.get_agent_advance_exceptions();
DROP FUNCTION IF EXISTS public._agent_advance_assert_new_money(uuid, numeric, uuid, text);
DROP FUNCTION IF EXISTS public._agent_advance_transfer_lookalike(uuid, numeric, uuid);
DROP FUNCTION IF EXISTS public._agent_advance_guard(text, text);
DROP FUNCTION IF EXISTS public._agent_advance_book_balance(uuid);
DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'agent-advance-reconciliation';
  END IF;
END $c$;
