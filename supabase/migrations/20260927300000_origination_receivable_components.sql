-- Agent Advance origination: make the receivable components derivable from the GL.
--
-- NOT YET APPLIED.
--
-- WHY
-- ---
-- `outstanding_balance` at origination is principal + access fee + registration
-- fee, but `agent_advance_component_state()` could only ever see the access fee:
--
--   * the principal receivable was posted as `rent_disbursement` on
--     source_table = 'agent_advance_requests'. That is the wrong category (the
--     base map sends `rent_disbursement` to A1 cash/bank; it only reaches A10
--     through a resolver exception in sofp_ledger_legs, and component_state
--     reads the base map) AND the wrong key (component_state filters
--     source_table = 'agent_advances' AND source_id = <advance id>).
--   * the registration fee had NO ledger entry at all.
--
-- Measured on a 685,000 advance (principal 500,000 / access 165,000 / reg
-- 20,000): components resolved to 165,000 -- a 520,000 gap. Under the approved
-- repayment waterfall that means the first installment allocates 100% to A11
-- and, once A11 is exhausted, every later repayment raises
-- ADVANCE_ALLOCATION_OVER_COLLECTION.
--
-- This is also a live defect independent of the waterfall. The current
-- origination group fails mapped double-entry outright -- BOTH legs map to
-- credits:
--     platform.rent_disbursement->A1/CR + wallet.agent_advance_credit->L1/CR
-- Production is already logging it (5 origination groups, residual 17,980,000;
-- plus 6 top-up groups, 13,000,000), masked only because
-- ledger_integrity_config.mapped_balance_mode = 'log'.
--
-- WHAT CHANGES
-- ------------
-- 1. The principal group's PLATFORM leg is re-classified and re-keyed:
--        'rent_disbursement'                  -> 'agent_advance_disbursement'
--        'agent_advance_requests'/p_request_id -> 'agent_advances'/v_advance_id
--    Same accounts (DR A10 / CR L1), same amount, same direction as the
--    resolver already produces -- a classification correction, not an
--    accounting change. It also removes the need for the `rent_disbursement`
--    resolver exception on new advances. This mirrors the correction already
--    approved and deployed for top-ups on 2026-09-27 (73c6427335).
--
-- 2. A registration fee pair is added, in its own transaction group, exactly
--    mirroring the access fee treatment approved on 2026-09-27:
--        platform agent_advance_registration_fee_charged cash_out -> DR A20
--        platform agent_advance_fee_revenue              cash_in  -> CR R2
--    R2 confirmed as the correct Agent Advance fee revenue account for both
--    fees: R2 exists precisely to separate Agent Advance fee income from R1,
--    and its label ("Agent Advance Fee Revenue") is already scoped to advance
--    fees generally. The July 2026 postings of agent advance registration fees
--    to R1 are NOT a precedent -- those were a different economic event (the
--    fee was deducted from the wallet upfront: DR L1 / CR R1) and were reversed
--    on 2026-07-29 when the policy changed to "repaid via installments, not
--    upfront". The upfront deduction was removed; no receivable entry was ever
--    added in its place. That omission is what this migration fixes.
--
-- WHAT DOES NOT CHANGE
-- --------------------
-- The wallet leg is untouched: same category, amount, direction, bucket,
-- recipient_type, description and source stamping. No cash, bank or mobile
-- money moves. No tenant, rent or landlord logic. No repayment logic. No
-- historical advance is altered, and there is no opening balance or plug --
-- this is forward-only, and all 327 currently open advances are pre-effective
-- and therefore untouched by the waterfall regardless.
--
-- Both new categories are already allowlisted and already mapped
-- (agent_advance_registration_fee_charged -> A20/cash_out,
--  agent_advance_fee_revenue -> R2/cash_out). No new accounts, categories or
-- mappings are required.
--
-- Production definition before this change: 8abb99dac5eb3f302afc37540b29a689
--   (160 non-comment body lines)

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

  -- Principal. The WALLET leg is unchanged in every respect -- same category,
  -- amount, direction, bucket, recipient_type, description and source stamping,
  -- so the money the agent receives is identical.
  --
  -- The PLATFORM leg is re-classified and re-keyed (see header):
  --   'rent_disbursement'/'agent_advance_requests' -> 'agent_advance_disbursement'/'agent_advances'
  -- giving DR A10 / CR L1 on the base map -- the same treatment the resolver
  -- exception was producing, now without needing the exception, and now visible
  -- to agent_advance_component_state().
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

  -- Access fee recognised in full at origination (CFO decision 2026-09-27).
  --   platform agent_advance_access_fee_charged cash_out -> DR A11
  --   platform agent_advance_fee_revenue        cash_in  -> CR R2
  -- Its OWN transaction group, so the principal group above is unaffected.
  -- Platform legs only: the fee is baked into the repayment schedule and never
  -- debited from the wallet, so there is no wallet leg and no A1/A2/L1
  -- movement. v_access_fee is the amount this call charged and stored on the
  -- advance; nothing is recomputed.
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

  -- Registration fee, recognised at origination on the same basis as the
  -- access fee (see header).
  --   platform agent_advance_registration_fee_charged cash_out -> DR A20
  --   platform agent_advance_fee_revenue              cash_in  -> CR R2
  -- Its own transaction group. Platform legs only -- since 2026-07-29 the
  -- registration fee is repaid through the installment schedule and is never
  -- deducted from the wallet, so there is no wallet leg and no cash movement.
  -- v_reg_fee is the amount this call charged and stored on the advance.
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
