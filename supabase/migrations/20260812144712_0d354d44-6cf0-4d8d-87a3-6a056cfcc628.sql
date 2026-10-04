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
  v_chain_complete boolean;
  v_evidence_source text;
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

  IF v_wallet_legs > 0 THEN
    v_wallet_state := 'wallet_already_debited';
  ELSIF v_wallet_legs = 0 AND v_platform_legs = 0 THEN
    v_wallet_state := 'wallet_not_debited';
  ELSE
    v_wallet_state := 'wallet_state_uncertain';
  END IF;

  -- A complete money trail is itself authoritative proof the payout executed.
  v_chain_complete := v_wallet_legs > 0 AND (v_float_leg > 0 OR v_oop > 0) AND v_comm_leg > 0;

  v_evidence_source := CASE
    WHEN v_evidence IS NOT NULL THEN 'finance_attached'
    WHEN v_chain_complete THEN 'ledger_settlement_chain'
    WHEN coalesce(w.fin_ops_reference, '') <> '' OR coalesce(w.transaction_id, '') <> '' THEN 'stamped_reference'
    WHEN w.payout_proof IS NOT NULL OR w.payout_proof_path IS NOT NULL THEN 'payout_proof_upload'
    WHEN EXISTS (SELECT 1 FROM public.payout_claim_sms_audit_log a
                 WHERE a.withdrawal_request_id = p_withdrawal_id AND a.validation_result = 'matched') THEN 'matched_sms_audit'
    ELSE NULL
  END;

  IF w.status <> 'processing' THEN
    v_blockers := v_blockers || to_jsonb('status_not_processing'::text);
  END IF;
  IF v_merchant IS NULL THEN
    v_blockers := v_blockers || to_jsonb('merchant_identity_missing'::text);
  END IF;
  IF v_evidence_source IS NULL THEN
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

  IF w.status <> 'processing' THEN
    v_class := 'not_stranded';
  ELSIF v_chain_complete THEN
    v_class := 'settled_state_only';
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
    'evidence_source', v_evidence_source,
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