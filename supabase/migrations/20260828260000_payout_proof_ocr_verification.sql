-- Payout proof-of-payment: verify the uploaded IMAGE, not just the pasted SMS.
-- Today only the pasted SMS text is parsed (amount + TID) and cross-checked
-- against the entered reference. Nothing ever reads the uploaded proof
-- screenshot's contents, so a merchant could paste a correct SMS and attach
-- an unrelated/doctored image and the system would never notice. This adds:
--   1. extracted_date/time/phone on the SMS audit log (parsePayoutConfirmationSms
--      now captures these too, not just amount+TID).
--   2. payout_proof_ocr_log — full per-attempt audit trail for the new
--      image-vision-extraction step (mirrors payout_claim_sms_audit_log).
--   3. A compact verdict column on withdrawal_requests for list/filter views.
-- The full design/policy lives in supabase/functions/approve-withdrawal/index.ts
-- and proofVision.ts — this migration only adds the storage for it.

ALTER TABLE public.payout_claim_sms_audit_log
  ADD COLUMN IF NOT EXISTS extracted_date text,
  ADD COLUMN IF NOT EXISTS extracted_time text,
  ADD COLUMN IF NOT EXISTS extracted_phone text;

CREATE TABLE IF NOT EXISTS public.payout_proof_ocr_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  withdrawal_request_id uuid,
  request_owner_id uuid,
  storage_path text,
  storage_bucket text,
  extracted_tid text,
  extracted_amount numeric,
  extracted_date text,
  extracted_time text,
  extracted_phone text,
  model_confidence text,
  reference_entered text,
  requested_amount numeric,
  -- Denormalized copy of what the SMS side found at the same moment, so one
  -- row shows the whole cross-check picture without a join.
  sms_extracted_amount numeric,
  sms_extracted_tid text,
  validation_result text NOT NULL, -- 'match' | 'mismatch' | 'unverifiable'
  validation_code text,
  validation_message text,
  approver_id uuid,
  approver_email text,
  approver_role text,
  ip_address text,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.payout_proof_ocr_log TO authenticated;
GRANT ALL ON public.payout_proof_ocr_log TO service_role;

ALTER TABLE public.payout_proof_ocr_log ENABLE ROW LEVEL SECURITY;

-- Same policy shape as payout_claim_sms_audit_log — staff roles, the
-- approving agent, or the request owner can read; any authenticated caller
-- can write (the edge function inserts under the settling agent's session).
CREATE POLICY "Staff can read payout proof ocr log"
ON public.payout_proof_ocr_log
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR has_role(auth.uid(), 'financial_ops'::app_role)
  OR approver_id = auth.uid()
  OR request_owner_id = auth.uid()
);

CREATE POLICY "Authenticated can write payout proof ocr log"
ON public.payout_proof_ocr_log
FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_ppol_withdrawal ON public.payout_proof_ocr_log (withdrawal_request_id);
CREATE INDEX IF NOT EXISTS idx_ppol_result ON public.payout_proof_ocr_log (validation_result);
-- Idempotency lookup: "have we already scored this exact image for this payout?"
CREATE INDEX IF NOT EXISTS idx_ppol_withdrawal_storage ON public.payout_proof_ocr_log (withdrawal_request_id, storage_path);

ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS payout_proof_verification_status text,
  ADD COLUMN IF NOT EXISTS payout_proof_verified_at timestamptz;
