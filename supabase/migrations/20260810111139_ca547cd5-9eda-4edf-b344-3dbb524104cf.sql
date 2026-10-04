-- 1. Traceability link between a request and the advance it created
ALTER TABLE public.agent_advances
  ADD COLUMN IF NOT EXISTS request_id uuid REFERENCES public.agent_advance_requests(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS agent_advances_request_id_key
  ON public.agent_advances(request_id) WHERE request_id IS NOT NULL;

-- 2. Atomic disbursement RPC
CREATE OR REPLACE FUNCTION public.disburse_agent_advance_request(
  p_request_id uuid,
  p_principal numeric DEFAULT NULL,
  p_cycle_days integer DEFAULT NULL,
  p_monthly_rate numeric DEFAULT NULL,
  p_repayment_frequency text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_skip_reason text DEFAULT NULL,
  p_recovery_source text DEFAULT 'wallet_daily',
  p_roi_recovery_percent numeric DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_req public.agent_advance_requests;
  v_principal numeric;
  v_cycle integer;
  v_rate numeric;
  v_freq text;
  v_reg_fee numeric;
  v_access_fee numeric;
  v_total numeric;
  v_installments integer;
  v_installment numeric;
  v_notes text;
  v_advance_id uuid;
  v_now timestamptz := now();
  v_group uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT (
    has_role(v_actor, 'super_admin'::app_role) OR has_role(v_actor, 'manager'::app_role)
    OR has_role(v_actor, 'cfo'::app_role) OR has_role(v_actor, 'coo'::app_role)
    OR has_role(v_actor, 'ceo'::app_role) OR has_role(v_actor, 'operations'::app_role)
    OR has_role(v_actor, 'agent_ops'::app_role) OR has_role(v_actor, 'financial_ops'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.staff_permissions sp
      WHERE sp.user_id = v_actor
        AND sp.permitted_dashboard IN ('agent-ops','financial-ops','company-ops')
    )
  ) THEN
    RAISE EXCEPTION 'Not authorized to disburse agent advances';
  END IF;

  SELECT * INTO v_req FROM public.agent_advance_requests
  WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Advance request not found';
  END IF;

  IF COALESCE(v_req.request_kind, 'new') <> 'new' THEN
    RAISE EXCEPTION 'Top-up requests must be merged with apply_advance_topup';
  END IF;

  IF v_req.status NOT IN ('pending','agent_ops_approved','cfo_approved','cfo_paid') THEN
    RAISE EXCEPTION 'Disbursement blocked — request status is %', v_req.status;
  END IF;

  -- Repair-safe: refuse if an advance row or ledger leg already exists for this request
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

  IF v_principal IS NULL OR v_principal < 10000 THEN
    RAISE EXCEPTION 'Principal must be at least UGX 10,000';
  END IF;
  IF v_cycle IS NULL OR v_cycle <= 0 THEN
    RAISE EXCEPTION 'Cycle days must be greater than zero';
  END IF;
  IF v_rate IS NULL OR v_rate <= 0 OR v_rate > 0.33 THEN
    RAISE EXCEPTION 'Monthly rate must be greater than 0 and at most 33%%';
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

  v_notes := NULLIF(concat_ws(' · ', NULLIF(p_notes, ''),
    CASE WHEN NULLIF(p_skip_reason,'') IS NOT NULL
         THEN '[CFO skipped by Agent Ops] ' || p_skip_reason END), '');

  UPDATE public.agent_advance_requests SET
    status = 'cfo_paid',
    cfo_approved_by = COALESCE(cfo_approved_by, v_actor),
    cfo_approved_at = COALESCE(cfo_approved_at, v_now),
    paid_by_cfo = COALESCE(paid_by_cfo, v_actor),
    cfo_paid_at = COALESCE(cfo_paid_at, v_now),
    cfo_adjusted_rate = CASE WHEN v_rate <> monthly_rate THEN v_rate ELSE cfo_adjusted_rate END,
    cfo_notes = COALESCE(v_notes, cfo_notes),
    principal = v_principal,
    cycle_days = v_cycle,
    registration_fee = v_reg_fee,
    access_fee = v_access_fee,
    total_payable = v_total,
    daily_payment = v_installment,
    monthly_rate = v_rate,
    repayment_frequency = v_freq,
    updated_at = v_now
  WHERE id = p_request_id;

  INSERT INTO public.agent_advances (
    agent_id, issued_by, request_id, principal, outstanding_balance, cycle_days,
    monthly_rate, daily_rate, access_fee, registration_fee, access_fee_collected,
    access_fee_status, status, repayment_frequency, installment_amount,
    daily_installment, expires_at, recovery_source, roi_recovery_percent
  ) VALUES (
    v_req.agent_id, v_actor, p_request_id, v_principal, v_total, v_cycle,
    v_rate, v_rate, v_access_fee, v_reg_fee, 0,
    'unpaid', 'active', v_freq, v_installment,
    v_installment, v_now + make_interval(days => v_cycle),
    COALESCE(p_recovery_source, 'wallet_daily'),
    CASE WHEN p_recovery_source = 'roi' THEN COALESCE(p_roi_recovery_percent, 0) ELSE 0 END
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
    'advance_disbursement:' || p_request_id::text,
    false
  );

  INSERT INTO public.system_events (event_type, user_id, description, metadata)
  VALUES ('funds_added', v_req.agent_id,
    'Agent advance disbursed to wallet',
    jsonb_build_object('request_id', p_request_id, 'advance_id', v_advance_id,
                       'principal', v_principal, 'actor_id', v_actor));

  RETURN jsonb_build_object(
    'advance_id', v_advance_id, 'transaction_group_id', v_group,
    'principal', v_principal, 'cycle_days', v_cycle, 'monthly_rate', v_rate,
    'access_fee', v_access_fee, 'registration_fee', v_reg_fee,
    'total_payable', v_total, 'installment', v_installment,
    'installments', v_installments, 'repayment_frequency', v_freq
  );
END;
$$;

REVOKE ALL ON FUNCTION public.disburse_agent_advance_request(uuid, numeric, integer, numeric, text, text, text, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.disburse_agent_advance_request(uuid, numeric, integer, numeric, text, text, text, text, numeric) TO authenticated;

-- 3. One-off repair: Sir Ian Martin's request d8b367fe was stamped cfo_paid with no advance row and no wallet credit
DO $repair$
DECLARE
  v_req public.agent_advance_requests;
  v_advance_id uuid;
BEGIN
  SELECT * INTO v_req FROM public.agent_advance_requests WHERE id = 'd8b367fe-6de3-47b6-8e4b-db8926e01231';
  IF v_req.id IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.agent_advances WHERE request_id = v_req.id) THEN RETURN; END IF;
  IF EXISTS (
    SELECT 1 FROM public.general_ledger
    WHERE source_table = 'agent_advance_requests' AND source_id = v_req.id
      AND category = 'agent_advance_credit'
  ) THEN RETURN; END IF;

  INSERT INTO public.agent_advances (
    agent_id, issued_by, request_id, principal, outstanding_balance, cycle_days,
    monthly_rate, daily_rate, access_fee, registration_fee, access_fee_collected,
    access_fee_status, status, repayment_frequency, installment_amount,
    daily_installment, issued_at, expires_at, recovery_source, roi_recovery_percent
  ) VALUES (
    v_req.agent_id, v_req.paid_by_cfo, v_req.id, v_req.principal, v_req.total_payable,
    v_req.cycle_days, v_req.monthly_rate, v_req.monthly_rate, v_req.access_fee,
    v_req.registration_fee, 0, 'unpaid', 'active', COALESCE(v_req.repayment_frequency,'daily'),
    v_req.daily_payment, v_req.daily_payment, v_req.cfo_paid_at,
    v_req.cfo_paid_at + make_interval(days => v_req.cycle_days), 'wallet_daily', 0
  ) RETURNING id INTO v_advance_id;

  PERFORM public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_req.agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_in',
        'amount', v_req.principal, 'category', 'agent_advance_credit',
        'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
        'source_table', 'agent_advance_requests', 'source_id', v_req.id,
        'description', 'Agent advance disbursement - ' || v_req.cycle_days || 'd @ ' || round(v_req.monthly_rate * 100) || '% (repair of failed payout)',
        'currency', 'UGX', 'transaction_date', now()
      ),
      jsonb_build_object(
        'user_id', v_req.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
        'amount', v_req.principal, 'category', 'rent_disbursement',
        'source_table', 'agent_advance_requests', 'source_id', v_req.id,
        'description', 'Agent advance disbursed to wallet (repair of failed payout)',
        'currency', 'UGX', 'transaction_date', now()
      )
    ),
    'advance_disbursement:' || v_req.id::text,
    false
  );
END
$repair$;