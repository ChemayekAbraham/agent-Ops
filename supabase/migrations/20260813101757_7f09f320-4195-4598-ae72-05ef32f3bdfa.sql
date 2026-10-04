-- Classifier now files unverified shortfalls as needs_review (matching the
-- payout path) instead of asserting a company debt, and it must not touch rows
-- a merchant or Finance already confirmed.
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

  SELECT COALESCE(SUM(gl.amount), 0) INTO v_float_telecom
  FROM public.general_ledger gl
  WHERE gl.reference_id = p_withdrawal_id::text || '-merchant-telecom-charge'
    AND gl.ledger_scope = 'wallet' AND gl.direction = 'cash_out';

  v_float_principal := LEAST(v_float_principal, v_amount);
  v_float_telecom := LEAST(v_float_telecom, v_telecom);
  v_own_principal := GREATEST(0, v_amount - v_float_principal);
  v_own_telecom := GREATEST(0, v_telecom - v_float_telecom);

  IF NOT v_completed OR (NOT v_has_reservation AND v_float_principal + v_float_telecom = 0) THEN
    v_source := CASE WHEN NOT v_completed THEN 'unknown' ELSE 'needs_review' END;
    v_note := CASE
      WHEN NOT v_completed
        THEN 'Payout not completed (status=' || COALESCE(w.status,'null') || '); funding source undecided.'
      ELSE 'No float reservation and no float movement on this payout: funding source cannot be proven from the books. Needs finance review before any receivable is raised.'
    END;

    -- Never leave a receivable this process itself invented.
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
            v_float_principal, ROUND(v_own_principal), 'needs_review',
            'Phase 6 classification: company float covered UGX ' ||
            ROUND(v_float_principal)::text || ' of UGX ' || ROUND(v_amount)::text ||
            '; UGX ' || ROUND(v_own_principal)::text ||
            ' awaits the merchant''s confirmation that it came from their own money.')
    ON CONFLICT (withdrawal_id, kind) DO UPDATE
      SET float_used = EXCLUDED.float_used,
          telecom_charge = EXCLUDED.telecom_charge,
          payout_amount = EXCLUDED.payout_amount,
          shortfall_amount = EXCLUDED.shortfall_amount,
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
            v_float_telecom, ROUND(v_own_telecom), 'needs_review',
            'Phase 6 classification: UGX ' || ROUND(v_own_telecom)::text ||
            ' of the telecom sending charge awaits the merchant''s confirmation.')
    ON CONFLICT (withdrawal_id, kind) DO UPDATE
      SET float_used = EXCLUDED.float_used,
          telecom_charge = EXCLUDED.telecom_charge,
          payout_amount = EXCLUDED.payout_amount,
          shortfall_amount = EXCLUDED.shortfall_amount,
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

-- Hourly release of float holds that should no longer hold anything.
SELECT cron.unschedule('release-stale-merchant-float')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'release-stale-merchant-float');

SELECT cron.schedule(
  'release-stale-merchant-float',
  '7 * * * *',
  $$SELECT public.release_stale_merchant_float_reservations();$$
);
