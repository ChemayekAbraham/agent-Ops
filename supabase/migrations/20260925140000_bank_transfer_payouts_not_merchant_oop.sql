-- Bank-transfer payouts are not merchant out-of-pocket (docs/HANDOVER/132).
--
-- classify_merchant_payout_funding booked every UGX a payout was not covered
-- by desk float as money the company owes the merchant ('Phase 6
-- classification ... fronted by the merchant from their own phone').
-- That is right for MoMo payouts sent from the merchant's own phone. It is
-- wrong for bank_transfer payouts: those are paid from a bank account that
-- WELILE treasury funds by bank transfer outside the ledger (WELILE Equity
-- ...5259 -> Bayo Mercy ...7542 -> payout account; MTN line -> Equity), so
-- the desk float is ~0 and the whole payout became a phantom receivable.
-- Sky Bubbles' BAITA desk accumulated UGX 488.5M of these between 2 and 24
-- Sep 2026 (closed by hand on 2026-09-25, system_events 02346834-...).
--
-- Change: a completed bank_transfer payout that float does not fully cover
-- now takes the existing no-receivable branch (funding_source
-- 'needs_review', with a treasury-funded note) instead of raising
-- pending_reimbursement rows. Float that WAS consumed is still recorded.
-- Finance can still raise a claim by hand when the merchant genuinely paid
-- from its own bank money. MoMo payouts are unchanged. Forward-only from
-- 2026-09-25 06:00 UTC: earlier payouts keep their classification.
--
-- Body copied from the live function (2026-09-25); only the marked lines differ.

CREATE OR REPLACE FUNCTION public.classify_merchant_payout_funding(p_withdrawal_id uuid, p_via text DEFAULT 'manual'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  w record;
  v_agent uuid;
  v_amount numeric := 0;
  v_telecom numeric := 0;
  v_float_principal numeric := 0;
  v_float_telecom numeric := 0;
  v_own_principal numeric := 0;
  v_own_telecom numeric := 0;
  v_source text;
  v_receivable numeric := 0;
  v_completed boolean := false;
  v_has_reservation boolean := false;
  v_note text := NULL;
  -- 20260925140000: bank_transfer payouts are treasury-funded, never merchant own cash.
  v_treasury_bank boolean := false;
  v_treasury_bank_cutoff CONSTANT timestamptz := '2026-09-25 06:00:00+00';
  -- Before this timestamp, no payout ever received an independent telecom
  -- ledger leg (the guard was principal-only in production); the real-leg
  -- read below would just read "0" for every one of them. Payouts at/after
  -- this point actually get a telecom leg when float covers it (fix
  -- shipped in 20260912130000). Corrected 20260912035500 -- the original
  -- cutoff (13:00 UTC) was written assuming a later deploy time than
  -- actually happened (03:53 UTC), which would have kept every payout in
  -- the 9 hours after real deploy on the old proportional-guess path.
  v_telecom_leg_cutoff CONSTANT timestamptz := '2026-09-12 03:50:00+00';
BEGIN
  SELECT * INTO w FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
  IF w.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'withdrawal_not_found');
  END IF;

  SELECT r.agent_id INTO v_agent
  FROM public.merchant_float_reservations r
  WHERE r.withdrawal_id = p_withdrawal_id
  LIMIT 1;
  v_has_reservation := v_agent IS NOT NULL;

  IF v_agent IS NULL THEN
    SELECT ca.agent_id INTO v_agent
    FROM public.cashout_agents ca
    WHERE ca.is_active = true
      AND ca.agent_id IN (w.dispatch_claimed_by, w.processed_by, w.processing_started_by)
    LIMIT 1;
  END IF;

  IF v_agent IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'not_a_merchant_payout');
  END IF;

  v_completed := COALESCE(w.status, '') IN ('paid', 'completed');
  v_amount := GREATEST(0, COALESCE(w.amount, 0));
  v_telecom := public.telecom_sending_charge(v_amount);

  SELECT COALESCE(SUM(gl.amount), 0) INTO v_float_principal
  FROM public.general_ledger gl
  WHERE gl.reference_id = p_withdrawal_id::text || '-merchant-float-consume'
    AND gl.ledger_scope = 'wallet' AND gl.direction = 'cash_out';

  v_float_principal := LEAST(v_float_principal, v_amount);

  IF COALESCE(w.processed_at, w.updated_at, w.created_at) >= v_telecom_leg_cutoff THEN
    SELECT COALESCE(SUM(gl.amount), 0) INTO v_float_telecom
    FROM public.general_ledger gl
    WHERE gl.reference_id = p_withdrawal_id::text || '-merchant-telecom-charge'
      AND gl.ledger_scope = 'wallet' AND gl.direction = 'cash_out';
    v_float_telecom := LEAST(v_float_telecom, v_telecom);
  ELSIF v_amount > 0 THEN
    v_float_telecom := LEAST(v_telecom, ROUND(v_telecom * v_float_principal / v_amount));
  ELSE
    v_float_telecom := 0;
  END IF;

  v_own_principal := GREATEST(0, v_amount - v_float_principal);
  v_own_telecom := GREATEST(0, v_telecom - v_float_telecom);

  -- 20260925140000
  -- Forward-only: payouts processed before the cutover keep their existing
  -- classification so open claims on other desks are never rewritten.
  v_treasury_bank := v_completed
    AND COALESCE(w.payout_method, '') = 'bank_transfer'
    AND COALESCE(w.processed_at, w.updated_at, w.created_at) >= v_treasury_bank_cutoff
    AND (v_own_principal + v_own_telecom) > 0;

  IF NOT v_completed OR (NOT v_has_reservation AND v_float_principal + v_float_telecom = 0) OR v_treasury_bank THEN
    v_source := CASE WHEN NOT v_completed THEN 'unknown' ELSE 'needs_review' END;
    v_note := CASE
      WHEN NOT v_completed
        THEN 'Payout not completed (status=' || COALESCE(w.status,'null') || '); funding source undecided.'
      WHEN v_treasury_bank
        THEN 'Bank-transfer payout: desk float covered UGX ' || ROUND(v_float_principal)::text || ' of UGX ' ||
             ROUND(v_amount)::text || '. The rest is treated as treasury-funded (WELILE funds the payout bank account by bank transfer outside the ledger), so no receivable is raised. Finance may raise one by hand with evidence.'
      ELSE 'No float reservation and no float movement on this payout: funding source cannot be proven from the books. Needs finance review before any receivable is raised.'
    END;

    DELETE FROM public.merchant_out_of_pocket_advances
    WHERE withdrawal_id = p_withdrawal_id
      AND status IN ('pending_reimbursement', 'needs_review')
      AND attested_at IS NULL
      AND reviewed_at IS NULL
      AND note LIKE 'Phase 6 classification:%';

    SELECT COALESCE(SUM(shortfall_amount), 0) INTO v_receivable
    FROM public.merchant_out_of_pocket_advances
    WHERE withdrawal_id = p_withdrawal_id;

    INSERT INTO public.merchant_payout_funding
      (withdrawal_id, agent_id, payout_amount, telecom_charge_expected,
       float_consumed_principal, float_consumed_telecom, own_cash_principal,
       own_cash_telecom, receivable_recorded, funding_source, classified_via, notes)
    VALUES (p_withdrawal_id, v_agent, v_amount, v_telecom, v_float_principal,
            v_float_telecom, 0, 0, v_receivable, v_source, p_via, v_note)
    ON CONFLICT (withdrawal_id) DO UPDATE
      SET agent_id = EXCLUDED.agent_id,
          payout_amount = EXCLUDED.payout_amount,
          telecom_charge_expected = EXCLUDED.telecom_charge_expected,
          float_consumed_principal = EXCLUDED.float_consumed_principal,
          float_consumed_telecom = EXCLUDED.float_consumed_telecom,
          own_cash_principal = 0,
          own_cash_telecom = 0,
          receivable_recorded = EXCLUDED.receivable_recorded,
          funding_source = EXCLUDED.funding_source,
          classified_via = EXCLUDED.classified_via,
          notes = EXCLUDED.notes,
          classified_at = now(),
          updated_at = now();

    RETURN jsonb_build_object('ok', true, 'withdrawal_id', p_withdrawal_id,
      'agent_id', v_agent, 'funding_source', v_source, 'status', w.status,
      'float_consumed_principal', v_float_principal,
      'own_cash_principal', 0, 'own_cash_telecom', 0,
      'receivable_recorded', v_receivable, 'note', v_note);
  END IF;

  v_source := CASE
    WHEN v_amount = 0 THEN 'none'
    WHEN v_float_principal + v_float_telecom = 0 THEN 'own_cash'
    WHEN v_own_principal + v_own_telecom = 0 THEN 'float'
    ELSE 'mixed'
  END;

  IF v_own_principal > 0 THEN
    INSERT INTO public.merchant_out_of_pocket_advances
      (agent_id, withdrawal_id, kind, payout_amount, telecom_charge, float_used,
       shortfall_amount, status, note)
    VALUES (v_agent, p_withdrawal_id, 'payout', v_amount, v_telecom,
            v_float_principal, ROUND(v_own_principal), 'pending_reimbursement',
            'Phase 6 classification: company float covered UGX ' ||
            ROUND(v_float_principal)::text || ' of UGX ' || ROUND(v_amount)::text ||
            '; UGX ' || ROUND(v_own_principal)::text ||
            ' fronted by the merchant from their own phone and recorded as money the company owes them.')
    ON CONFLICT (withdrawal_id, kind) DO UPDATE
      SET float_used = EXCLUDED.float_used,
          telecom_charge = EXCLUDED.telecom_charge,
          payout_amount = EXCLUDED.payout_amount,
          shortfall_amount = EXCLUDED.shortfall_amount,
          status = EXCLUDED.status,
          note = EXCLUDED.note,
          updated_at = now()
      WHERE public.merchant_out_of_pocket_advances.status IN ('pending_reimbursement', 'needs_review')
        AND public.merchant_out_of_pocket_advances.attested_at IS NULL
        AND public.merchant_out_of_pocket_advances.reviewed_at IS NULL;
  ELSE
    DELETE FROM public.merchant_out_of_pocket_advances
    WHERE withdrawal_id = p_withdrawal_id AND kind = 'payout'
      AND status IN ('pending_reimbursement', 'needs_review')
      AND attested_at IS NULL
      AND reviewed_at IS NULL;
  END IF;

  IF v_own_telecom > 0 THEN
    INSERT INTO public.merchant_out_of_pocket_advances
      (agent_id, withdrawal_id, kind, payout_amount, telecom_charge, float_used,
       shortfall_amount, status, note)
    VALUES (v_agent, p_withdrawal_id, 'telecom', v_amount, v_telecom,
            v_float_telecom, ROUND(v_own_telecom), 'pending_reimbursement',
            'Phase 6 classification: telecom fee is reserved/debited in the same breath as the principal; company float covered UGX ' ||
            ROUND(v_float_telecom)::text || ' of UGX ' || ROUND(v_telecom)::text ||
            ' (same coverage ratio as the principal). UGX ' || ROUND(v_own_telecom)::text ||
            ' fronted by the merchant from their own phone and recorded as money the company owes them.')
    ON CONFLICT (withdrawal_id, kind) DO UPDATE
      SET float_used = EXCLUDED.float_used,
          telecom_charge = EXCLUDED.telecom_charge,
          payout_amount = EXCLUDED.payout_amount,
          shortfall_amount = EXCLUDED.shortfall_amount,
          status = EXCLUDED.status,
          note = EXCLUDED.note,
          updated_at = now()
      WHERE public.merchant_out_of_pocket_advances.status IN ('pending_reimbursement', 'needs_review')
        AND public.merchant_out_of_pocket_advances.attested_at IS NULL
        AND public.merchant_out_of_pocket_advances.reviewed_at IS NULL;
  ELSE
    DELETE FROM public.merchant_out_of_pocket_advances
    WHERE withdrawal_id = p_withdrawal_id AND kind = 'telecom'
      AND status IN ('pending_reimbursement', 'needs_review')
      AND attested_at IS NULL
      AND reviewed_at IS NULL;
  END IF;

  SELECT COALESCE(SUM(shortfall_amount), 0) INTO v_receivable
  FROM public.merchant_out_of_pocket_advances
  WHERE withdrawal_id = p_withdrawal_id;

  INSERT INTO public.merchant_payout_funding
    (withdrawal_id, agent_id, payout_amount, telecom_charge_expected,
     float_consumed_principal, float_consumed_telecom, own_cash_principal,
     own_cash_telecom, receivable_recorded, funding_source, classified_via, notes)
  VALUES (p_withdrawal_id, v_agent, v_amount, v_telecom, v_float_principal,
          v_float_telecom, ROUND(v_own_principal), ROUND(v_own_telecom),
          v_receivable, v_source, p_via, NULL)
  ON CONFLICT (withdrawal_id) DO UPDATE
    SET agent_id = EXCLUDED.agent_id,
        payout_amount = EXCLUDED.payout_amount,
        telecom_charge_expected = EXCLUDED.telecom_charge_expected,
        float_consumed_principal = EXCLUDED.float_consumed_principal,
        float_consumed_telecom = EXCLUDED.float_consumed_telecom,
        own_cash_principal = EXCLUDED.own_cash_principal,
        own_cash_telecom = EXCLUDED.own_cash_telecom,
        receivable_recorded = EXCLUDED.receivable_recorded,
        funding_source = EXCLUDED.funding_source,
        classified_via = EXCLUDED.classified_via,
        notes = NULL,
        classified_at = now(),
        updated_at = now();

  UPDATE public.merchant_float_reservations
     SET consumed_float = v_float_principal,
         consumed_telecom = v_float_telecom,
         out_of_pocket_amount = ROUND(v_own_principal + v_own_telecom),
         updated_at = now()
   WHERE withdrawal_id = p_withdrawal_id;

  RETURN jsonb_build_object(
    'ok', true, 'withdrawal_id', p_withdrawal_id, 'agent_id', v_agent,
    'funding_source', v_source, 'payout_amount', v_amount,
    'telecom_charge_expected', v_telecom,
    'float_consumed_principal', v_float_principal,
    'float_consumed_telecom', v_float_telecom,
    'own_cash_principal', ROUND(v_own_principal),
    'own_cash_telecom', ROUND(v_own_telecom),
    'receivable_recorded', v_receivable);
END;
$function$;
