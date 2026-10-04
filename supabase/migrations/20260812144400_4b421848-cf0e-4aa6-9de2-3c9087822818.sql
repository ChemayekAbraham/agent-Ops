-- ============================================================================
-- PHASE 1: Safe settlement replay for stranded `processing` withdrawals.
-- The customer payout already happened in the real world; only the financial
-- settlement legs are missing. Nothing here may initiate a new payout, mint a
-- TID, or double-debit a customer wallet.
-- ============================================================================

-- 1. Payment evidence store -------------------------------------------------
CREATE TABLE public.withdrawal_payment_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id uuid NOT NULL UNIQUE REFERENCES public.withdrawal_requests(id) ON DELETE CASCADE,
  transaction_id text,
  evidence_source text NOT NULL,
  evidence_note text NOT NULL,
  raw_sms text,
  amount_confirmed numeric,
  attached_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.withdrawal_payment_evidence TO authenticated;
GRANT ALL ON public.withdrawal_payment_evidence TO service_role;
ALTER TABLE public.withdrawal_payment_evidence ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance can read payout evidence"
ON public.withdrawal_payment_evidence FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
);

-- 2. Replay audit trail -----------------------------------------------------
CREATE TABLE public.withdrawal_settlement_replay_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id uuid NOT NULL,
  dry_run boolean NOT NULL DEFAULT true,
  ok boolean NOT NULL DEFAULT false,
  classification text NOT NULL,
  wallet_state text,
  detected_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  legs_created jsonb NOT NULL DEFAULT '[]'::jsonb,
  final_state text,
  error_message text,
  reason text,
  performed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_wsra_withdrawal ON public.withdrawal_settlement_replay_audit(withdrawal_id, created_at DESC);

GRANT SELECT ON public.withdrawal_settlement_replay_audit TO authenticated;
GRANT ALL ON public.withdrawal_settlement_replay_audit TO service_role;
ALTER TABLE public.withdrawal_settlement_replay_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance can read replay audit"
ON public.withdrawal_settlement_replay_audit FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
);

-- 3. Helpers ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.welile_telecom_sending_charge(p_amount numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN coalesce(p_amount,0) <= 0 THEN 0
    WHEN p_amount <= 5000 THEN 100
    WHEN p_amount <= 60000 THEN 500
    WHEN p_amount <= 500000 THEN 1000
    WHEN p_amount <= 1000000 THEN 1500
    ELSE 2000
  END::numeric;
$$;

CREATE OR REPLACE FUNCTION public.can_replay_settlement(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_role(_user_id, 'cfo')
      OR public.has_role(_user_id, 'financial_ops')
      OR public.has_role(_user_id, 'manager')
      OR public.has_role(_user_id, 'super_admin');
$$;

-- 4. Classifier -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.classify_stranded_withdrawal(p_withdrawal_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  w record;
  v_merchant uuid;
  v_wallet_legs int;
  v_platform_legs int;
  v_float_leg numeric;
  v_telecom_leg numeric;
  v_comm_leg numeric;
  v_oop numeric;
  v_evidence record;
  v_wallet_state text;
  v_class text;
  v_blockers jsonb := '[]'::jsonb;
  v_float_avail numeric;
  v_telecom_expected numeric;
BEGIN
  IF NOT public.can_replay_settlement(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to classify settlement replay';
  END IF;

  SELECT * INTO w FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
  IF w IS NULL THEN
    RAISE EXCEPTION 'Withdrawal % not found', p_withdrawal_id;
  END IF;

  v_merchant := coalesce(w.processing_started_by, w.assigned_cashout_agent_id);

  SELECT count(*) FILTER (WHERE ledger_scope = 'wallet' AND user_id = w.user_id AND direction = 'cash_out'),
         count(*) FILTER (WHERE ledger_scope = 'platform')
    INTO v_wallet_legs, v_platform_legs
  FROM public.general_ledger
  WHERE source_table = 'withdrawal_requests' AND source_id = p_withdrawal_id;

  SELECT coalesce(sum(amount) FILTER (WHERE reference_id = p_withdrawal_id::text || '-merchant-float-consume' AND ledger_scope = 'wallet'), 0),
         coalesce(sum(amount) FILTER (WHERE reference_id = p_withdrawal_id::text || '-merchant-telecom-charge' AND ledger_scope = 'wallet'), 0),
         coalesce(sum(amount) FILTER (WHERE reference_id = p_withdrawal_id::text || '-cashout-commission' AND ledger_scope = 'wallet'), 0)
    INTO v_float_leg, v_telecom_leg, v_comm_leg
  FROM public.general_ledger
  WHERE reference_id LIKE p_withdrawal_id::text || '-%';

  SELECT coalesce(sum(shortfall_amount), 0) INTO v_oop
  FROM public.merchant_out_of_pocket_advances WHERE withdrawal_id = p_withdrawal_id;

  SELECT * INTO v_evidence FROM public.withdrawal_payment_evidence WHERE withdrawal_id = p_withdrawal_id;

  SELECT coalesce(float_balance, 0) INTO v_float_avail FROM public.wallets WHERE user_id = v_merchant;
  v_telecom_expected := public.welile_telecom_sending_charge(w.amount);

  -- Wallet debit classification (never guessed).
  IF v_wallet_legs > 0 THEN
    v_wallet_state := 'wallet_already_debited';
  ELSIF v_wallet_legs = 0 AND v_platform_legs = 0 THEN
    v_wallet_state := 'wallet_not_debited';
  ELSE
    v_wallet_state := 'wallet_state_uncertain';
  END IF;

  -- Blockers: any of these stops automatic replay.
  IF w.status <> 'processing' THEN
    v_blockers := v_blockers || to_jsonb('status_not_processing'::text);
  END IF;
  IF v_merchant IS NULL THEN
    v_blockers := v_blockers || to_jsonb('merchant_identity_missing'::text);
  END IF;
  IF v_evidence IS NULL
     AND coalesce(w.fin_ops_reference, '') = ''
     AND coalesce(w.transaction_id, '') = ''
     AND w.payout_proof IS NULL AND w.payout_proof_path IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.payout_claim_sms_audit_log a
                     WHERE a.withdrawal_request_id = p_withdrawal_id AND a.validation_result = 'matched')
  THEN
    v_blockers := v_blockers || to_jsonb('payment_evidence_missing'::text);
  END IF;
  IF v_wallet_state = 'wallet_not_debited' THEN
    v_blockers := v_blockers || to_jsonb('customer_wallet_not_debited'::text);
  ELSIF v_wallet_state = 'wallet_state_uncertain' THEN
    v_blockers := v_blockers || to_jsonb('customer_wallet_state_uncertain'::text);
  END IF;
  IF coalesce(w.pool_funded, false) THEN
    v_blockers := v_blockers || to_jsonb('pool_funded_needs_manual_review'::text);
  END IF;

  -- Classification
  IF w.status <> 'processing' THEN
    v_class := 'not_stranded';
  ELSIF v_wallet_legs > 0 AND (v_float_leg > 0 OR v_oop > 0) AND v_comm_leg > 0 THEN
    v_class := 'settled_state_only'; -- money fully recorded, only status stuck
  ELSIF v_wallet_legs > 0 THEN
    v_class := 'partial_settlement_replayable';
  ELSE
    v_class := 'unsettled_needs_manual_classification';
  END IF;

  RETURN jsonb_build_object(
    'withdrawal_id', p_withdrawal_id,
    'classification', v_class,
    'wallet_state', v_wallet_state,
    'blockers', v_blockers,
    'status', w.status,
    'amount', w.amount,
    'payout_method', w.payout_method,
    'customer_id', w.user_id,
    'merchant_id', v_merchant,
    'proxy_partner_id', w.proxy_partner_id,
    'pool_funded', coalesce(w.pool_funded, false),
    'processing_started_at', w.processing_started_at,
    'processed_at', w.processed_at,
    'fin_ops_reference', w.fin_ops_reference,
    'transaction_id', w.transaction_id,
    'has_proof', (w.payout_proof IS NOT NULL OR w.payout_proof_path IS NOT NULL),
    'evidence', CASE WHEN v_evidence IS NULL THEN NULL ELSE jsonb_build_object(
        'transaction_id', v_evidence.transaction_id,
        'source', v_evidence.evidence_source,
        'note', v_evidence.evidence_note,
        'attached_by', v_evidence.attached_by,
        'attached_at', v_evidence.created_at) END,
    'ledger', jsonb_build_object(
        'customer_wallet_debit_legs', v_wallet_legs,
        'platform_legs', v_platform_legs,
        'float_leg_amount', v_float_leg,
        'telecom_leg_amount', v_telecom_leg,
        'commission_leg_amount', v_comm_leg),
    'out_of_pocket_amount', v_oop,
    'merchant_float_available', coalesce(v_float_avail, 0),
    'telecom_charge_expected', v_telecom_expected,
    'commission_expected', round(w.amount * 0.005),
    'sms_audit_rows', (SELECT count(*) FROM public.payout_claim_sms_audit_log a WHERE a.withdrawal_request_id = p_withdrawal_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.classify_stranded_withdrawal(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.classify_stranded_withdrawal(uuid) TO authenticated, service_role;

-- 5. Evidence attachment ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.attach_withdrawal_payment_evidence(
  p_withdrawal_id uuid,
  p_evidence_source text,
  p_evidence_note text,
  p_transaction_id text DEFAULT NULL,
  p_raw_sms text DEFAULT NULL,
  p_amount_confirmed numeric DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.withdrawal_payment_evidence;
BEGIN
  IF NOT public.can_replay_settlement(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to attach payout evidence';
  END IF;
  IF coalesce(length(trim(p_evidence_note)), 0) < 10 THEN
    RAISE EXCEPTION 'Evidence note must be at least 10 characters';
  END IF;
  IF coalesce(trim(p_evidence_source), '') = '' THEN
    RAISE EXCEPTION 'Evidence source is required';
  END IF;

  INSERT INTO public.withdrawal_payment_evidence AS e (
    withdrawal_id, transaction_id, evidence_source, evidence_note, raw_sms,
    amount_confirmed, attached_by
  ) VALUES (
    p_withdrawal_id, nullif(trim(p_transaction_id), ''), trim(p_evidence_source),
    trim(p_evidence_note), p_raw_sms, p_amount_confirmed, auth.uid()
  )
  ON CONFLICT (withdrawal_id) DO UPDATE
    SET transaction_id = coalesce(EXCLUDED.transaction_id, e.transaction_id),
        evidence_source = EXCLUDED.evidence_source,
        evidence_note = EXCLUDED.evidence_note,
        raw_sms = coalesce(EXCLUDED.raw_sms, e.raw_sms),
        amount_confirmed = coalesce(EXCLUDED.amount_confirmed, e.amount_confirmed),
        attached_by = EXCLUDED.attached_by,
        updated_at = now()
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (auth.uid(), 'withdrawal_payment_evidence_attached', 'withdrawal_requests',
          p_withdrawal_id::text,
          jsonb_build_object('source', v_row.evidence_source, 'reason', v_row.evidence_note,
                             'transaction_id', v_row.transaction_id));

  RETURN to_jsonb(v_row);
END;
$$;

REVOKE ALL ON FUNCTION public.attach_withdrawal_payment_evidence(uuid, text, text, text, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attach_withdrawal_payment_evidence(uuid, text, text, text, text, numeric) TO authenticated, service_role;

-- 6. Controlled, idempotent replay -----------------------------------------
CREATE OR REPLACE FUNCTION public.replay_withdrawal_settlement(
  p_withdrawal_id uuid,
  p_dry_run boolean DEFAULT true,
  p_reason text DEFAULT NULL,
  p_approve_customer_wallet_debit boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_state jsonb;
  v_class text;
  v_wallet_state text;
  v_blockers jsonb;
  v_actions jsonb := '[]'::jsonb;
  v_legs jsonb := '[]'::jsonb;
  w record;
  v_merchant uuid;
  v_float_avail numeric;
  v_float_principal numeric;
  v_principal_short numeric;
  v_telecom_expected numeric;
  v_telecom_float numeric;
  v_telecom_short numeric;
  v_float_leg numeric;
  v_telecom_leg numeric;
  v_comm_leg numeric;
  v_oop numeric;
  v_commission numeric;
  v_final text;
  v_ok boolean := false;
  v_err text := NULL;
  v_now timestamptz := now();
BEGIN
  IF NOT public.can_replay_settlement(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to replay settlement';
  END IF;
  IF NOT p_dry_run AND coalesce(length(trim(p_reason)), 0) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required for a live replay';
  END IF;

  v_state := public.classify_stranded_withdrawal(p_withdrawal_id);
  v_class := v_state->>'classification';
  v_wallet_state := v_state->>'wallet_state';
  v_blockers := v_state->'blockers';

  SELECT * INTO w FROM public.withdrawal_requests WHERE id = p_withdrawal_id FOR UPDATE;
  v_merchant := coalesce(w.processing_started_by, w.assigned_cashout_agent_id);

  -- A CFO may explicitly clear the wallet-debit blocker after classifying the
  -- case; it is never cleared automatically.
  IF p_approve_customer_wallet_debit AND public.has_role(auth.uid(), 'cfo') THEN
    v_blockers := (
      SELECT coalesce(jsonb_agg(b), '[]'::jsonb) FROM jsonb_array_elements(v_blockers) b
      WHERE b #>> '{}' NOT IN ('customer_wallet_not_debited', 'customer_wallet_state_uncertain')
    );
    v_actions := v_actions || to_jsonb('cfo_cleared_wallet_blocker'::text);
  END IF;

  -- Refuse when anything is unresolved: the record stays visible for manual work.
  IF jsonb_array_length(v_blockers) > 0 THEN
    v_final := 'blocked_manual_review';
    v_err := 'blocked: ' || (SELECT string_agg(b #>> '{}', ', ') FROM jsonb_array_elements(v_blockers) b);
    INSERT INTO public.withdrawal_settlement_replay_audit (
      withdrawal_id, dry_run, ok, classification, wallet_state, detected_state,
      blockers, actions, legs_created, final_state, error_message, reason, performed_by)
    VALUES (p_withdrawal_id, p_dry_run, false, v_class, v_wallet_state, v_state,
            v_blockers, v_actions, v_legs, v_final, v_err, p_reason, auth.uid());
    RETURN jsonb_build_object('ok', false, 'final_state', v_final, 'blockers', v_blockers,
                              'detected_state', v_state, 'actions', v_actions);
  END IF;

  v_float_leg := (v_state#>>'{ledger,float_leg_amount}')::numeric;
  v_telecom_leg := (v_state#>>'{ledger,telecom_leg_amount}')::numeric;
  v_comm_leg := (v_state#>>'{ledger,commission_leg_amount}')::numeric;
  v_oop := (v_state->>'out_of_pocket_amount')::numeric;
  v_float_avail := (v_state->>'merchant_float_available')::numeric;
  v_telecom_expected := (v_state->>'telecom_charge_expected')::numeric;
  v_commission := round(w.amount * 0.005);

  v_float_principal := least(v_float_avail, w.amount);
  v_principal_short := greatest(0, w.amount - v_float_principal);
  v_telecom_float := least(greatest(0, v_float_avail - v_float_principal), v_telecom_expected);
  v_telecom_short := greatest(0, v_telecom_expected - v_telecom_float);

  IF p_dry_run THEN
    IF v_float_leg = 0 AND v_float_principal > 0 THEN v_actions := v_actions || to_jsonb(('would_post_float_consume:' || v_float_principal)::text); END IF;
    IF v_telecom_leg = 0 AND v_telecom_float > 0 THEN v_actions := v_actions || to_jsonb(('would_post_telecom_charge:' || v_telecom_float)::text); END IF;
    IF v_oop = 0 AND (v_principal_short > 0 OR v_telecom_short > 0) THEN v_actions := v_actions || to_jsonb(('would_record_out_of_pocket:' || (v_principal_short + v_telecom_short))::text); END IF;
    IF v_comm_leg = 0 THEN v_actions := v_actions || to_jsonb(('would_credit_commission:' || v_commission)::text); END IF;
    v_actions := v_actions || to_jsonb('would_finalize_withdrawal'::text);
    INSERT INTO public.withdrawal_settlement_replay_audit (
      withdrawal_id, dry_run, ok, classification, wallet_state, detected_state,
      blockers, actions, legs_created, final_state, reason, performed_by)
    VALUES (p_withdrawal_id, true, true, v_class, v_wallet_state, v_state,
            v_blockers, v_actions, v_legs, 'dry_run_ok', p_reason, auth.uid());
    RETURN jsonb_build_object('ok', true, 'dry_run', true, 'final_state', 'dry_run_ok',
                              'actions', v_actions, 'detected_state', v_state);
  END IF;

  BEGIN
    -- (a) Merchant float consumption — idempotent on reference + key.
    IF v_float_leg = 0 AND v_float_principal > 0 THEN
      PERFORM public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object('user_id', v_merchant, 'ledger_scope', 'wallet', 'direction', 'cash_out',
            'amount', v_float_principal, 'category', 'agent_float_settlement',
            'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
            'source_table', 'withdrawal_requests', 'source_id', p_withdrawal_id,
            'description', 'Replay: company float used to settle customer cash-out ' || p_withdrawal_id,
            'currency', 'UGX', 'reference_id', p_withdrawal_id::text || '-merchant-float-consume',
            'transaction_date', v_now),
          jsonb_build_object('user_id', v_merchant, 'ledger_scope', 'platform', 'direction', 'cash_in',
            'amount', v_float_principal, 'category', 'agent_float_settlement',
            'source_table', 'withdrawal_requests', 'source_id', p_withdrawal_id,
            'description', 'Replay: merchant float settled to customer for withdrawal ' || p_withdrawal_id,
            'currency', 'UGX', 'reference_id', p_withdrawal_id::text || '-merchant-float-consume',
            'transaction_date', v_now)),
        'approve-withdrawal-merchant-float-consume-' || p_withdrawal_id::text,
        true);
      v_legs := v_legs || to_jsonb((p_withdrawal_id::text || '-merchant-float-consume:' || v_float_principal)::text);
    END IF;

    -- (b) Telecom sending charge — exactly once.
    IF v_telecom_leg = 0 AND v_telecom_float > 0 THEN
      PERFORM public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object('user_id', v_merchant, 'ledger_scope', 'wallet', 'direction', 'cash_out',
            'amount', v_telecom_float, 'category', 'agent_float_settlement',
            'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
            'source_table', 'withdrawal_requests', 'source_id', p_withdrawal_id,
            'description', 'Replay: telecom sending charge for merchant cash-out ' || p_withdrawal_id,
            'currency', 'UGX', 'reference_id', p_withdrawal_id::text || '-merchant-telecom-charge',
            'transaction_date', v_now),
          jsonb_build_object('user_id', v_merchant, 'ledger_scope', 'platform', 'direction', 'cash_in',
            'amount', v_telecom_float, 'category', 'agent_float_settlement',
            'source_table', 'withdrawal_requests', 'source_id', p_withdrawal_id,
            'description', 'Replay: telecom charge recovered from merchant float for ' || p_withdrawal_id,
            'currency', 'UGX', 'reference_id', p_withdrawal_id::text || '-merchant-telecom-charge',
            'transaction_date', v_now)),
        'approve-withdrawal-merchant-telecom-charge-' || p_withdrawal_id::text,
        true);
      v_legs := v_legs || to_jsonb((p_withdrawal_id::text || '-merchant-telecom-charge:' || v_telecom_float)::text);
    END IF;

    -- (c) Out-of-pocket receivable — unique per (withdrawal_id, kind).
    IF v_principal_short > 0 THEN
      INSERT INTO public.merchant_out_of_pocket_advances
        (agent_id, withdrawal_id, kind, payout_amount, telecom_charge, float_used, shortfall_amount, status, note)
      VALUES (v_merchant, p_withdrawal_id, 'payout', w.amount, v_telecom_expected, v_float_principal,
              round(v_principal_short), 'pending_reimbursement',
              'Replay reconstruction: merchant fronted own money beyond available float.')
      ON CONFLICT (withdrawal_id, kind) DO NOTHING;
      v_legs := v_legs || to_jsonb(('out_of_pocket_payout:' || round(v_principal_short))::text);
    END IF;
    IF v_telecom_short > 0 THEN
      INSERT INTO public.merchant_out_of_pocket_advances
        (agent_id, withdrawal_id, kind, payout_amount, telecom_charge, float_used, shortfall_amount, status, note)
      VALUES (v_merchant, p_withdrawal_id, 'telecom', w.amount, v_telecom_expected, v_telecom_float,
              round(v_telecom_short), 'pending_reimbursement',
              'Replay reconstruction: telecom sending charge paid from merchant own line.')
      ON CONFLICT (withdrawal_id, kind) DO NOTHING;
      v_legs := v_legs || to_jsonb(('out_of_pocket_telecom:' || round(v_telecom_short))::text);
    END IF;

    -- (d) Commission 0.5% — only when a float debit or receivable backs it.
    SELECT coalesce(sum(amount) FILTER (WHERE ledger_scope = 'wallet'), 0) INTO v_float_leg
      FROM public.general_ledger WHERE reference_id = p_withdrawal_id::text || '-merchant-float-consume';
    SELECT coalesce(sum(shortfall_amount), 0) INTO v_oop
      FROM public.merchant_out_of_pocket_advances WHERE withdrawal_id = p_withdrawal_id;

    IF v_comm_leg = 0 AND v_commission > 0 AND (v_float_leg > 0 OR v_oop > 0) THEN
      PERFORM public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object('user_id', v_merchant, 'ledger_scope', 'platform', 'direction', 'cash_out',
            'amount', v_commission, 'category', 'agent_commission_earned',
            'source_table', 'withdrawal_requests', 'source_id', p_withdrawal_id,
            'description', 'Replay: cashout payout commission expense (0.5%) for ' || p_withdrawal_id,
            'currency', 'UGX', 'reference_id', p_withdrawal_id::text || '-cashout-commission',
            'transaction_date', v_now),
          jsonb_build_object('user_id', v_merchant, 'ledger_scope', 'wallet', 'direction', 'cash_in',
            'amount', v_commission, 'category', 'agent_commission_earned',
            'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
            'source_table', 'withdrawal_requests', 'source_id', p_withdrawal_id,
            'description', 'Replay: cash-out commission (0.5%) for withdrawal ' || p_withdrawal_id,
            'currency', 'UGX', 'reference_id', p_withdrawal_id::text || '-cashout-commission',
            'transaction_date', v_now)),
        'approve-withdrawal-cashout-commission-' || p_withdrawal_id::text,
        true);
      v_legs := v_legs || to_jsonb((p_withdrawal_id::text || '-cashout-commission:' || v_commission)::text);
    ELSIF v_comm_leg = 0 AND NOT (v_float_leg > 0 OR v_oop > 0) THEN
      v_actions := v_actions || to_jsonb('commission_withheld_no_offsetting_leg'::text);
    END IF;

    -- (e) Verify the invariant before declaring the payout settled.
    SELECT coalesce(sum(amount) FILTER (WHERE reference_id = p_withdrawal_id::text || '-cashout-commission' AND ledger_scope = 'wallet'), 0)
      INTO v_comm_leg FROM public.general_ledger WHERE reference_id LIKE p_withdrawal_id::text || '-%';

    IF (v_float_leg > 0 OR v_oop > 0) AND v_comm_leg > 0 THEN
      UPDATE public.withdrawal_requests
         SET status = 'completed',
             processed_at = coalesce(processed_at, v_now),
             processed_by = coalesce(processed_by, v_merchant),
             updated_at = v_now
       WHERE id = p_withdrawal_id AND status = 'processing';
      v_actions := v_actions || to_jsonb('withdrawal_marked_completed'::text);
      v_final := 'settled';
      v_ok := true;
    ELSE
      v_final := 'settlement_incomplete_manual_review';
      v_err := 'required settlement legs missing after replay';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_final := 'replay_failed';
    v_err := SQLERRM;
    v_ok := false;
  END;

  INSERT INTO public.withdrawal_settlement_replay_audit (
    withdrawal_id, dry_run, ok, classification, wallet_state, detected_state,
    blockers, actions, legs_created, final_state, error_message, reason, performed_by)
  VALUES (p_withdrawal_id, false, v_ok, v_class, v_wallet_state, v_state,
          v_blockers, v_actions, v_legs, v_final, v_err, p_reason, auth.uid());

  IF NOT v_ok THEN
    INSERT INTO public.settlement_reconciliation_ledger
      (channel, period_date, external_reference, external_amount, system_amount, discrepancy_amount, status, notes)
    VALUES ('settlement_replay_failed', current_date, p_withdrawal_id::text, w.amount, 0, w.amount, 'pending',
            'replay final_state=' || v_final || ' :: ' || coalesce(v_err, ''));
  END IF;

  RETURN jsonb_build_object('ok', v_ok, 'final_state', v_final, 'actions', v_actions,
                            'legs_created', v_legs, 'error', v_err, 'detected_state', v_state);
END;
$$;

REVOKE ALL ON FUNCTION public.replay_withdrawal_settlement(uuid, boolean, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.replay_withdrawal_settlement(uuid, boolean, text, boolean) TO authenticated, service_role;