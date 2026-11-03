-- Matched payout-SMS audit inserts were failing in
-- finalize_withdrawal_from_matched_payout_sms() because both UPDATE branches
-- assigned withdrawal_requests.metadata. That table has no metadata column
-- (same fact as 20261020125000). payout_claim_sms_audit_log.metadata does
-- exist and stays. The evidence row, system_events payload, transaction_id,
-- and the settled status update are unchanged. CREATE OR REPLACE keeps grants.
-- Idempotent.

CREATE OR REPLACE FUNCTION public.finalize_withdrawal_from_matched_payout_sms()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
           updated_at = now()
     WHERE id = NEW.withdrawal_request_id
       AND status IN ('pending','requested','manager_approved','cfo_approved','fin_ops_approved','approved','processing','paid');
  ELSE
    -- Evidence only: keep the working status, do NOT stamp processed_at.
    -- Missing legs stay on system_events; settlement_missing_legs has its own writer.
    UPDATE public.withdrawal_requests
       SET transaction_id = COALESCE(transaction_id, v_tid),
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
$function$;
