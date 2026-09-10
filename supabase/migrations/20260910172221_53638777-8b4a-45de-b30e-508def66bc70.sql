CREATE OR REPLACE FUNCTION public.enforce_deposit_requests_agent_immutable_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Staff and financial roles retain full update authority; this trigger only
  -- restricts an agent acting on their own assigned row.
  IF public.has_role(auth.uid(), 'manager'::public.app_role)
     OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
     OR public.has_role(auth.uid(), 'coo'::public.app_role)
     OR public.has_role(auth.uid(), 'cfo'::public.app_role)
     OR public.has_role(auth.uid(), 'operations'::public.app_role)
     OR public.has_role(auth.uid(), 'financial_ops'::public.app_role)
  THEN
    RETURN NEW;
  END IF;

  -- Service-role workers have no authenticated user, and non-agent callers are
  -- handled by RLS. This guard is specifically for the assigned agent path.
  IF auth.uid() IS NULL OR auth.uid() <> OLD.agent_id THEN
    RETURN NEW;
  END IF;

  -- RLS permits only pending -> processing for this path. Freeze every field
  -- that could affect ownership, value, verification, review, or audit.
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Agents cannot change the deposit customer';
  END IF;
  IF NEW.agent_id IS DISTINCT FROM OLD.agent_id THEN
    RAISE EXCEPTION 'Agents cannot reassign the deposit request';
  END IF;
  IF NEW.amount IS DISTINCT FROM OLD.amount THEN
    RAISE EXCEPTION 'Agents cannot change the deposit amount after the request is created';
  END IF;
  IF NEW.deposit_purpose IS DISTINCT FROM OLD.deposit_purpose THEN
    RAISE EXCEPTION 'Agents cannot change the deposit purpose';
  END IF;
  IF NEW.provider IS DISTINCT FROM OLD.provider THEN
    RAISE EXCEPTION 'Agents cannot change the deposit provider';
  END IF;
  IF NEW.transaction_id IS DISTINCT FROM OLD.transaction_id THEN
    RAISE EXCEPTION 'Agents cannot change the deposit transaction reference';
  END IF;
  IF NEW.transaction_date IS DISTINCT FROM OLD.transaction_date THEN
    RAISE EXCEPTION 'Agents cannot change the deposit transaction date';
  END IF;
  IF NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION 'Agents cannot change the approval timestamp';
  END IF;
  IF NEW.rejected_at IS DISTINCT FROM OLD.rejected_at THEN
    RAISE EXCEPTION 'Agents cannot change the rejection timestamp';
  END IF;
  IF NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason THEN
    RAISE EXCEPTION 'Agents cannot change the rejection reason';
  END IF;
  IF NEW.processed_by IS DISTINCT FROM OLD.processed_by THEN
    RAISE EXCEPTION 'Agents cannot change the deposit processor';
  END IF;
  IF NEW.audit_flagged IS DISTINCT FROM OLD.audit_flagged THEN
    RAISE EXCEPTION 'Agents cannot change the deposit audit flag';
  END IF;
  IF NEW.auto_approved IS DISTINCT FROM OLD.auto_approved THEN
    RAISE EXCEPTION 'Agents cannot change the auto_approved flag';
  END IF;
  IF NEW.batch_run_id IS DISTINCT FROM OLD.batch_run_id THEN
    RAISE EXCEPTION 'Agents cannot change the deposit batch';
  END IF;
  IF NEW.purpose_audit IS DISTINCT FROM OLD.purpose_audit THEN
    RAISE EXCEPTION 'Agents cannot change the deposit purpose audit';
  END IF;
  IF NEW.auto_match_audit IS DISTINCT FROM OLD.auto_match_audit THEN
    RAISE EXCEPTION 'Agents cannot change the deposit matching audit';
  END IF;
  IF NEW.auto_credit_review_status IS DISTINCT FROM OLD.auto_credit_review_status THEN
    RAISE EXCEPTION 'Agents cannot change the automatic-credit review status';
  END IF;
  IF NEW.auto_credit_reviewed_by IS DISTINCT FROM OLD.auto_credit_reviewed_by THEN
    RAISE EXCEPTION 'Agents cannot change the automatic-credit reviewer';
  END IF;
  IF NEW.auto_credit_reviewed_at IS DISTINCT FROM OLD.auto_credit_reviewed_at THEN
    RAISE EXCEPTION 'Agents cannot change the automatic-credit review time';
  END IF;
  IF NEW.auto_credit_review_notes IS DISTINCT FROM OLD.auto_credit_review_notes THEN
    RAISE EXCEPTION 'Agents cannot change the automatic-credit review notes';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deposit_requests_agent_immutable_fields ON public.deposit_requests;
CREATE TRIGGER trg_deposit_requests_agent_immutable_fields
BEFORE UPDATE ON public.deposit_requests
FOR EACH ROW
EXECUTE FUNCTION public.enforce_deposit_requests_agent_immutable_fields();

CREATE OR REPLACE FUNCTION public.enforce_nfc_card_immutable_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Card rotation is represented by revoking the old row and inserting a new
  -- one. These identity and authorization fields must never change in place.
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'NFC card owner cannot be changed';
  END IF;
  IF NEW.card_id IS DISTINCT FROM OLD.card_id THEN
    RAISE EXCEPTION 'NFC card identity cannot be changed';
  END IF;
  IF NEW.pin_hash IS DISTINCT FROM OLD.pin_hash THEN
    RAISE EXCEPTION 'NFC card PIN cannot be changed; create a replacement card';
  END IF;
  IF NEW.pinless_limit IS DISTINCT FROM OLD.pinless_limit THEN
    RAISE EXCEPTION 'NFC card spending limit cannot be changed; create a replacement card';
  END IF;
  IF NEW.hmac_signature_preview IS DISTINCT FROM OLD.hmac_signature_preview THEN
    RAISE EXCEPTION 'NFC card signature preview cannot be changed';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'NFC card creation time cannot be changed';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_nfc_cards_immutable_fields ON public.nfc_cards;
CREATE TRIGGER trg_nfc_cards_immutable_fields
BEFORE UPDATE ON public.nfc_cards
FOR EACH ROW
EXECUTE FUNCTION public.enforce_nfc_card_immutable_fields();