
CREATE TABLE public.payout_code_audit_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  withdrawal_request_id UUID,
  payout_code_id UUID,
  code_entered TEXT,
  code_on_file TEXT,
  outcome TEXT NOT NULL,
  status_result TEXT,
  approver_id UUID,
  approver_email TEXT,
  approver_role TEXT,
  request_owner_id UUID,
  amount NUMERIC,
  error_code TEXT,
  error_message TEXT,
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pcal_withdrawal ON public.payout_code_audit_log(withdrawal_request_id);
CREATE INDEX idx_pcal_approver ON public.payout_code_audit_log(approver_id);
CREATE INDEX idx_pcal_created ON public.payout_code_audit_log(created_at DESC);
CREATE INDEX idx_pcal_outcome ON public.payout_code_audit_log(outcome);

GRANT SELECT ON public.payout_code_audit_log TO authenticated;
GRANT ALL ON public.payout_code_audit_log TO service_role;

ALTER TABLE public.payout_code_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read payout code audit log"
ON public.payout_code_audit_log
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'operations'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'ceo'::app_role)
  OR approver_id = auth.uid()
  OR request_owner_id = auth.uid()
);
