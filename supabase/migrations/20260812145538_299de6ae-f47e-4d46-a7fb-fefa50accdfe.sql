-- =====================================================================
-- SMS/TID evidence must never, by itself, mean financial settlement.
-- =====================================================================

ALTER TABLE public.withdrawal_payment_evidence ALTER COLUMN attached_by DROP NOT NULL;

-- 1. Authoritative settlement checker --------------------------------------
CREATE OR REPLACE FUNCTION public.withdrawal_settlement_status(p_withdrawal_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w record;
  v_merchant uuid;
  v_wallet_debit int := 0;
  v_float numeric := 0;
  v_telecom numeric := 0;
  v_comm numeric := 0;
  v_oop numeric := 0;
  v_missing jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO w FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
  IF w IS NULL THEN
    RETURN jsonb_build_object('settled', false, 'missing', to_jsonb(ARRAY['withdrawal_not_found']));
  END IF;

  v_merchant := coalesce(w.processing_started_by, w.assigned_cashout_agent_id, w.dispatch_claimed_by);

  SELECT count(*) INTO v_wallet_debit
  FROM public.general_ledger
  WHERE source_table = 'withdrawal_requests'
    AND source_id = p_withdrawal_id
    AND ledger_scope = 'wallet'
    AND user_id = w.user_id
    AND direction = 'cash_out';

  SELECT coalesce(sum(amount) FILTER (WHERE reference_id = p_withdrawal_id::text || '-merchant-float-consume'), 0),
         coalesce(sum(amount) FILTER (WHERE reference_id = p_withdrawal_id::text || '-merchant-telecom-charge'), 0),
         coalesce(sum(amount) FILTER (WHERE reference_id = p_withdrawal_id::text || '-cashout-commission'), 0)
    INTO v_float, v_telecom, v_comm
  FROM public.general_ledger
  WHERE reference_id LIKE p_withdrawal_id::text || '-%';

  SELECT coalesce(sum(shortfall_amount), 0) INTO v_oop
  FROM public.merchant_out_of_pocket_advances
  WHERE withdrawal_id = p_withdrawal_id;

  IF v_wallet_debit = 0 THEN
    v_missing := v_missing || to_jsonb('customer_wallet_debit'::text);
  END IF;

  IF v_merchant IS NOT NULL THEN
    IF v_float <= 0 AND v_oop <= 0 THEN
      v_missing := v_missing || to_jsonb('merchant_float_or_out_of_pocket'::text);
    END IF;
    IF v_telecom <= 0 THEN
      v_missing := v_missing || to_jsonb('merchant_telecom_charge'::text);
    END IF;
    IF v_comm <= 0 THEN
      v_missing := v_missing || to_jsonb('merchant_commission'::text);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'withdrawal_id', p_withdrawal_id,
    'settled', jsonb_array_length(v_missing) = 0,
    'missing', v_missing,
    'merchant_id', v_merchant,
    'customer_wallet_debit_legs', v_wallet_debit,
    'float_consumed', v_float,
    'out_of_pocket', v_oop,
    'telecom_charge', v_telecom,
    'commission', v_comm
  );
END;
$$;

REVOKE ALL ON FUNCTION public.withdrawal_settlement_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.withdrawal_settlement_status(uuid) TO authenticated, service_role;

-- 2. SMS match becomes EVIDENCE-ONLY unless settlement is verified --------
CREATE OR REPLACE FUNCTION public.finalize_withdrawal_from_matched_payout_sms()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tid text;
  v_settlement jsonb;
  v_settled boolean;
BEGIN
  IF NEW.validation_result <> 'matched'
     OR NEW.withdrawal_request_id IS NULL
     OR NEW.extracted_tid IS NULL
     OR btrim(NEW.extracted_tid) = '' THEN
    RETURN NEW;
  END IF;

  v_tid := upper(btrim(NEW.extracted_tid));

  -- Always persist the payment evidence (never a financial state).
  INSERT INTO public.withdrawal_payment_evidence AS e (
    withdrawal_id, transaction_id, evidence_source, evidence_note,
    raw_sms, amount_confirmed, attached_by
  ) VALUES (
    NEW.withdrawal_request_id, v_tid, 'sms_match',
    'Automatic TID match from payout confirmation SMS',
    NEW.raw_sms, NEW.extracted_amount, NEW.approver_id
  )
  ON CONFLICT (withdrawal_id) DO UPDATE
    SET transaction_id = COALESCE(e.transaction_id, EXCLUDED.transaction_id),
        raw_sms = COALESCE(e.raw_sms, EXCLUDED.raw_sms),
        amount_confirmed = COALESCE(e.amount_confirmed, EXCLUDED.amount_confirmed),
        updated_at = now();

  v_settlement := public.withdrawal_settlement_status(NEW.withdrawal_request_id);
  v_settled := coalesce((v_settlement->>'settled')::boolean, false);

  IF v_settled THEN
    UPDATE public.withdrawal_requests
       SET status = CASE WHEN status IN ('completed', 'disbursed') THEN status ELSE 'paid' END,
           fin_ops_reference = COALESCE(fin_ops_reference, v_tid),
           transaction_id = COALESCE(transaction_id, v_tid),
           processed_at = COALESCE(processed_at, NEW.created_at, now()),
           processed_by = COALESCE(processed_by, NEW.approver_id),
           fin_ops_verified_at = COALESCE(fin_ops_verified_at, NEW.created_at, now()),
           fin_ops_verified_by = COALESCE(fin_ops_verified_by, NEW.approver_id),
           metadata = coalesce(metadata, '{}'::jsonb)
                      || jsonb_build_object('settlement_verified_at', now(),
                                            'settlement_finalized_by', 'sms_match_trigger'),
           updated_at = now()
     WHERE id = NEW.withdrawal_request_id
       AND status IN ('pending','requested','manager_approved','cfo_approved','fin_ops_approved','approved','processing','paid');
  ELSE
    -- Evidence only: keep the working status, do NOT stamp processed_at.
    UPDATE public.withdrawal_requests
       SET transaction_id = COALESCE(transaction_id, v_tid),
           metadata = coalesce(metadata, '{}'::jsonb)
                      || jsonb_build_object(
                           'payment_evidence_tid', v_tid,
                           'settlement_pending', true,
                           'settlement_missing_legs', v_settlement->'missing',
                           'settlement_evidence_at', now()),
           updated_at = now()
     WHERE id = NEW.withdrawal_request_id
       AND status NOT IN ('completed','disbursed','paid','rejected','cancelled');

    INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
    VALUES ('withdrawal.payment_evidence_without_settlement',
            NEW.request_owner_id, 'withdrawal_requests', NEW.withdrawal_request_id,
            jsonb_build_object('tid', v_tid, 'settlement', v_settlement));
  END IF;

  RETURN NEW;
END;
$$;

-- 3. Reconciler: authoritative owner of finalisation ----------------------
CREATE OR REPLACE FUNCTION public.reconcile_evidenced_withdrawal_settlements()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_settlement jsonb;
  v_finalized int := 0;
  v_alerted int := 0;
BEGIN
  FOR r IN
    SELECT w.id, w.status, e.transaction_id, e.created_at AS evidence_at, w.user_id
      FROM public.withdrawal_payment_evidence e
      JOIN public.withdrawal_requests w ON w.id = e.withdrawal_id
     WHERE w.status NOT IN ('completed','disbursed','paid','rejected','cancelled')
     ORDER BY e.created_at
     LIMIT 500
  LOOP
    v_settlement := public.withdrawal_settlement_status(r.id);

    IF coalesce((v_settlement->>'settled')::boolean, false) THEN
      UPDATE public.withdrawal_requests
         SET status = 'paid',
             fin_ops_reference = COALESCE(fin_ops_reference, r.transaction_id),
             transaction_id = COALESCE(transaction_id, r.transaction_id),
             processed_at = COALESCE(processed_at, now()),
             fin_ops_verified_at = COALESCE(fin_ops_verified_at, now()),
             metadata = coalesce(metadata, '{}'::jsonb)
                        || jsonb_build_object('settlement_pending', false,
                                              'settlement_verified_at', now(),
                                              'settlement_finalized_by', 'settlement_reconciler'),
             updated_at = now()
       WHERE id = r.id;
      v_finalized := v_finalized + 1;
    ELSIF r.evidence_at < now() - interval '20 minutes' THEN
      INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
      VALUES ('withdrawal.settlement_incomplete_alert', r.user_id,
              'withdrawal_requests', r.id,
              jsonb_build_object('settlement', v_settlement, 'evidence_at', r.evidence_at));
      v_alerted := v_alerted + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('finalized', v_finalized, 'alerted', v_alerted, 'ran_at', now());
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_evidenced_withdrawal_settlements() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_evidenced_withdrawal_settlements() TO service_role;

SELECT cron.unschedule('reconcile-evidenced-withdrawal-settlements')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reconcile-evidenced-withdrawal-settlements');

SELECT cron.schedule(
  'reconcile-evidenced-withdrawal-settlements',
  '*/10 * * * *',
  $cron$SELECT public.reconcile_evidenced_withdrawal_settlements();$cron$
);
