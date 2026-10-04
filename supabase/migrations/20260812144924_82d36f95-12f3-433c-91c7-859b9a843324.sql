CREATE OR REPLACE FUNCTION public.replay_withdrawal_settlement(p_withdrawal_id uuid, p_dry_run boolean DEFAULT true, p_reason text DEFAULT NULL::text, p_approve_customer_wallet_debit boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Only the components that are NOT already recorded may be reconstructed.
  -- An existing float/telecom leg is authoritative: it can never be topped up,
  -- and it can never turn into an out-of-pocket receivable.
  IF v_float_leg > 0 THEN
    v_float_principal := v_float_leg;
    v_principal_short := 0;
  ELSE
    v_float_principal := least(v_float_avail, w.amount);
    v_principal_short := greatest(0, w.amount - v_float_principal);
  END IF;

  IF v_telecom_leg > 0 THEN
    v_telecom_float := v_telecom_leg;
    v_telecom_short := 0;
  ELSE
    v_telecom_float := least(greatest(0, v_float_avail - least(v_float_avail, v_float_principal)), v_telecom_expected);
    v_telecom_short := greatest(0, v_telecom_expected - v_telecom_float);
  END IF;

  -- An out-of-pocket claim already on file is never duplicated or extended.
  IF v_oop > 0 THEN
    v_principal_short := 0;
    v_telecom_short := 0;
  END IF;

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
$function$;