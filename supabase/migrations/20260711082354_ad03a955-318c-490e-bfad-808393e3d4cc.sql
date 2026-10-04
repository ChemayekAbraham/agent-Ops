CREATE TABLE public.payout_claim_sms_audit_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  withdrawal_request_id uuid,
  request_owner_id uuid,
  raw_sms text,
  extracted_tid text,
  extracted_amount numeric,
  reference_entered text,
  requested_amount numeric,
  validation_result text NOT NULL,
  validation_code text,
  validation_message text,
  approver_id uuid,
  approver_email text,
  approver_role text,
  payout_method text,
  ip_address text,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.payout_claim_sms_audit_log TO authenticated;
GRANT ALL ON public.payout_claim_sms_audit_log TO service_role;

ALTER TABLE public.payout_claim_sms_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read payout claim sms audit log"
ON public.payout_claim_sms_audit_log
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR approver_id = auth.uid()
  OR request_owner_id = auth.uid()
);

CREATE POLICY "Authenticated can write payout claim sms audit log"
ON public.payout_claim_sms_audit_log
FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE INDEX idx_pcsal_withdrawal ON public.payout_claim_sms_audit_log (withdrawal_request_id);
CREATE INDEX idx_pcsal_approver ON public.payout_claim_sms_audit_log (approver_id);
CREATE INDEX idx_pcsal_created ON public.payout_claim_sms_audit_log (created_at DESC);
CREATE INDEX idx_pcsal_result ON public.payout_claim_sms_audit_log (validation_result);