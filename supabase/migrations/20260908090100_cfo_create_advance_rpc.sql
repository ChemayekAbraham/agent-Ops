-- CFO advance issuance RPC + gate preview
-- =======================================
-- Companion to 20260908090000_cfo_advance_gate_override.sql.
--
--   agent_advance_blocking_gates()  - what WOULD block this issuance, so the CFO
--                                     sees it before filling the form, not at submit.
--   cfo_create_advance()            - the single privileged entry point that creates a
--                                     CFO-initiated request, optionally with the gates
--                                     stood down, always with an audit record.
--   disburse_agent_advance_request  - patched so its own principal/rate floors respect
--                                     an override and so the flag reaches agent_advances.

-- ---------------------------------------------------------------------------
-- 1. Which gates would block this agent right now?
--    Mirrors the trigger logic exactly; used for preview and for the audit record.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_advance_blocking_gates(
  p_agent_id     uuid,
  p_principal    numeric DEFAULT NULL,
  p_monthly_rate numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_gates text[] := ARRAY[]::text[];
  v_labels text[] := ARRAY[]::text[];
  v_name_key text;
  v_dup_name text;
  v_expected_rate numeric;
  v_completed int;
  v_outstanding numeric;
BEGIN
  IF p_agent_id IS NULL THEN
    RETURN jsonb_build_object('gates', v_gates, 'labels', v_labels, 'blocked', false);
  END IF;

  -- agent role
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = p_agent_id AND ur.enabled = true
      AND ur.role IN ('agent'::app_role, 'senior_agent'::app_role, 'sub_agent'::app_role)
  ) THEN
    v_gates  := v_gates  || 'not_an_agent'::text;
    v_labels := v_labels || 'This user does not hold an agent role.'::text;
  END IF;

  -- zz_enforce_agent_advance_activity
  IF NOT (public.agent_advance_activity(p_agent_id)->>'eligible')::boolean THEN
    v_gates  := v_gates  || 'no_activity'::text;
    v_labels := v_labels || 'No recorded agent work: no sub-agent, rent request, collection, promissory note or verified listing.'::text;
  END IF;

  -- trg_enforce_no_double_agent_advance
  SELECT COALESCE(SUM(a.outstanding_balance), 0) INTO v_outstanding
  FROM public.agent_advances a
  WHERE a.agent_id = p_agent_id AND a.status IN ('active','overdue') AND a.outstanding_balance > 0;

  IF v_outstanding > 0 THEN
    v_gates  := v_gates  || 'ongoing_advance'::text;
    v_labels := v_labels || format('Agent already has an ongoing advance (outstanding UGX %s).', round(v_outstanding));
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.agent_advance_requests r
    WHERE r.agent_id = p_agent_id
      AND r.status IN ('pending','agent_ops_approved','tenant_ops_approved','landlord_ops_approved','coo_approved')
  ) THEN
    v_gates  := v_gates  || 'pending_request'::text;
    v_labels := v_labels || 'Agent already has a request moving through the approval pipeline.'::text;
  END IF;

  -- zz_enforce_no_duplicate_account_advance
  IF EXISTS (
    SELECT 1 FROM public.agent_duplicate_flags f
    WHERE f.agent_id = p_agent_id AND f.status = 'active'
  ) THEN
    v_gates  := v_gates  || 'duplicate_flag'::text;
    v_labels := v_labels || 'This account is flagged as a duplicate account.'::text;
  END IF;

  SELECT nullif(lower(regexp_replace(coalesce(p.full_name,''), '[^a-zA-Z]', '', 'g')), '')
    INTO v_name_key
  FROM public.profiles p WHERE p.id = p_agent_id;

  IF v_name_key IS NOT NULL AND length(v_name_key) >= 6 THEN
    SELECT p.full_name INTO v_dup_name
    FROM public.profiles p
    WHERE p.id <> p_agent_id
      AND lower(regexp_replace(coalesce(p.full_name,''), '[^a-zA-Z]', '', 'g')) = v_name_key
      AND (
        EXISTS (SELECT 1 FROM public.agent_advances a
                WHERE a.agent_id = p.id AND a.status IN ('active','overdue') AND a.outstanding_balance > 0)
        OR EXISTS (SELECT 1 FROM public.agent_advance_requests r
                   WHERE r.agent_id = p.id
                     AND r.status IN ('pending','agent_ops_approved','tenant_ops_approved','landlord_ops_approved','coo_approved'))
      )
    LIMIT 1;

    IF v_dup_name IS NOT NULL THEN
      v_gates  := v_gates  || 'duplicate_name'::text;
      v_labels := v_labels || format('Another account named %s already has an advance or a pending request.', v_dup_name);
    END IF;
  END IF;

  -- trg_enforce_agent_advance_min_principal / row min principal
  IF p_principal IS NOT NULL AND p_principal < 10000 THEN
    v_gates  := v_gates  || 'below_min_principal'::text;
    v_labels := v_labels || 'Principal is below the UGX 10,000 minimum.'::text;
  END IF;

  -- trg_enforce_tiered_advance_rate (silent rewrite, not an error)
  IF p_monthly_rate IS NOT NULL THEN
    SELECT COUNT(*) INTO v_completed
    FROM public.agent_advances WHERE agent_id = p_agent_id AND status = 'completed';
    v_expected_rate := CASE WHEN v_completed > 0 THEN 0.28 ELSE 0.33 END;

    IF p_monthly_rate IS DISTINCT FROM v_expected_rate THEN
      v_gates  := v_gates  || 'rate_rewritten'::text;
      v_labels := v_labels || format('Rate would be silently reset to %s%% (the tier for this agent) unless overridden.',
                                     round(v_expected_rate * 100));
    END IF;

    IF p_monthly_rate > 0.33 THEN
      v_gates  := v_gates  || 'rate_above_standard'::text;
      v_labels := v_labels || 'Rate exceeds the 33% standard.'::text;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'gates',   to_jsonb(v_gates),
    'labels',  to_jsonb(v_labels),
    'blocked', array_length(v_gates, 1) IS NOT NULL
  );
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.agent_advance_blocking_gates(uuid, numeric, numeric) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The privileged issuance entry point.
--    Fees are computed with the SAME formula disburse_agent_advance_request uses,
--    so the row the CFO confirms is the row that gets disbursed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cfo_create_advance(
  p_agent_id            uuid,
  p_principal           numeric,
  p_cycle_days          integer,
  p_monthly_rate        numeric,
  p_repayment_frequency text,
  p_reason              text,
  p_override            boolean DEFAULT false,
  p_override_reason     text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_now   timestamptz := now();
  v_gates jsonb;
  v_gate_list text[];
  v_reg_fee numeric;
  v_access_fee numeric;
  v_total numeric;
  v_installments integer;
  v_installment numeric;
  v_freq text := COALESCE(NULLIF(btrim(COALESCE(p_repayment_frequency,'')), ''), 'daily');
  v_req public.agent_advance_requests;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT (
    has_role(v_actor, 'cfo'::app_role) OR has_role(v_actor, 'ceo'::app_role)
    OR has_role(v_actor, 'super_admin'::app_role) OR has_role(v_actor, 'admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized to initiate an advance';
  END IF;

  IF p_agent_id IS NULL THEN
    RAISE EXCEPTION 'An agent must be selected';
  END IF;
  IF p_principal IS NULL OR p_principal <= 0 THEN
    RAISE EXCEPTION 'Principal must be greater than zero';
  END IF;
  IF p_cycle_days IS NULL OR p_cycle_days <= 0 THEN
    RAISE EXCEPTION 'Cycle days must be greater than zero';
  END IF;
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

  -- Snapshot what the gates say right now, so the audit record shows exactly what
  -- was bypassed rather than just "an override happened".
  v_gates := public.agent_advance_blocking_gates(p_agent_id, p_principal, p_monthly_rate);
  SELECT array_agg(g) INTO v_gate_list
  FROM jsonb_array_elements_text(v_gates->'gates') g;

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
  )
  RETURNING * INTO v_req;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (
    v_actor,
    CASE WHEN COALESCE(p_override, false) THEN 'cfo_advance_gate_override' ELSE 'cfo_initiated_advance' END,
    'agent_advance_requests', v_req.id::text,
    CASE WHEN COALESCE(p_override, false) THEN btrim(p_override_reason) ELSE btrim(p_reason) END,
    jsonb_build_object(
      'agent_id', p_agent_id,
      'principal', p_principal,
      'cycle_days', p_cycle_days,
      'monthly_rate', p_monthly_rate,
      'repayment_frequency', v_freq,
      'access_fee', v_access_fee,
      'registration_fee', v_reg_fee,
      'total_payable', v_total,
      'installment', v_installment,
      'override', COALESCE(p_override, false),
      'gates_at_issue', v_gates,
      'reason', btrim(p_reason)
    )
  );

  RETURN jsonb_build_object(
    'request', to_jsonb(v_req),
    'gates_at_issue', v_gates,
    'access_fee', v_access_fee,
    'registration_fee', v_reg_fee,
    'total_payable', v_total,
    'installment', v_installment,
    'installments', v_installments
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.cfo_create_advance(uuid, numeric, integer, numeric, text, text, boolean, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.cfo_create_advance(uuid, numeric, integer, numeric, text, text, boolean, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Disbursement honours the override and carries it onto the advance row.
--    Only the two guarded checks and the INSERT column list changed; everything
--    else is production's existing body.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.disburse_agent_advance_request(
  p_request_id uuid,
  p_principal numeric DEFAULT NULL::numeric,
  p_cycle_days integer DEFAULT NULL::integer,
  p_monthly_rate numeric DEFAULT NULL::numeric,
  p_repayment_frequency text DEFAULT NULL::text,
  p_notes text DEFAULT NULL::text,
  p_skip_reason text DEFAULT NULL::text,
  p_recovery_source text DEFAULT 'wallet_daily'::text,
  p_roi_recovery_percent numeric DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
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
  v_override boolean;
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

  -- The CFO skip-path is permanently removed: any attempt to pass a skip reason is rejected.
  IF NULLIF(p_skip_reason, '') IS NOT NULL THEN
    RAISE EXCEPTION 'CFO approval is mandatory — the skip-CFO path has been removed';
  END IF;

  SELECT * INTO v_req FROM public.agent_advance_requests
  WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Advance request not found';
  END IF;

  v_override := COALESCE(v_req.gate_override, false);

  IF COALESCE(v_req.request_kind, 'new') <> 'new' THEN
    RAISE EXCEPTION 'Top-up requests must be merged with apply_advance_topup';
  END IF;

  -- MANDATORY CFO GATE: only CFO-approved (or already CFO-paid) requests may disburse.
  -- This is never overridable — an override is a CFO decision, so it presupposes one.
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

  IF v_cycle IS NULL OR v_cycle <= 0 THEN
    RAISE EXCEPTION 'Cycle days must be greater than zero';
  END IF;

  IF v_override THEN
    -- Gates stood down by an audited CFO override: only nonsense values are refused.
    IF v_principal IS NULL OR v_principal <= 0 THEN
      RAISE EXCEPTION 'Principal must be greater than zero';
    END IF;
    IF v_rate IS NULL OR v_rate < 0 OR v_rate > 1 THEN
      RAISE EXCEPTION 'Monthly rate must be between 0%% and 100%%';
    END IF;
  ELSE
    IF v_principal IS NULL OR v_principal < 10000 THEN
      RAISE EXCEPTION 'Principal must be at least UGX 10,000';
    END IF;
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
    'advance_disbursement:' || p_request_id::text,
    false
  );

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
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Overrides must be reviewable. One row per bypassed issuance.
-- ---------------------------------------------------------------------------
-- security_invoker so the caller's own RLS on agent_advance_requests decides what
-- they can see — the view must not become a way around it.
CREATE OR REPLACE VIEW public.v_advance_gate_overrides
WITH (security_invoker = true) AS
SELECT
  r.id                    AS request_id,
  r.created_at,
  r.agent_id,
  ap.full_name            AS agent_name,
  ap.phone                AS agent_phone,
  r.principal,
  r.cycle_days,
  r.monthly_rate,
  r.total_payable,
  r.status,
  r.gate_override_by,
  op.full_name            AS overridden_by_name,
  r.gate_override_at,
  r.gate_override_reason,
  r.gate_override_gates,
  a.id                    AS advance_id,
  a.outstanding_balance,
  a.status                AS advance_status
FROM public.agent_advance_requests r
LEFT JOIN public.profiles ap ON ap.id = r.agent_id
LEFT JOIN public.profiles op ON op.id = r.gate_override_by
LEFT JOIN public.agent_advances a ON a.request_id = r.id
WHERE r.gate_override = true;

REVOKE ALL ON public.v_advance_gate_overrides FROM public, anon;
GRANT SELECT ON public.v_advance_gate_overrides TO authenticated, service_role;
