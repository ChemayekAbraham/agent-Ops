CREATE TABLE public.landlord_approval_audit (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  rent_request_id UUID NOT NULL,
  tenant_id UUID,
  landlord_id UUID,
  operator_id UUID NOT NULL,
  previous_status TEXT,
  new_status TEXT NOT NULL,
  status_changed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  bonus_credit_queued BOOLEAN NOT NULL DEFAULT false,
  bonus_credit_note TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.landlord_approval_audit TO authenticated;
GRANT ALL ON public.landlord_approval_audit TO service_role;

ALTER TABLE public.landlord_approval_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Operators can record their own approval audit entries"
ON public.landlord_approval_audit
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = operator_id);

CREATE POLICY "Ops roles can view landlord approval audit"
ON public.landlord_approval_audit
FOR SELECT
TO authenticated
USING (
  auth.uid() = operator_id
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'cfo')
);

CREATE INDEX idx_landlord_approval_audit_request ON public.landlord_approval_audit(rent_request_id);
CREATE INDEX idx_landlord_approval_audit_operator ON public.landlord_approval_audit(operator_id);
CREATE INDEX idx_landlord_approval_audit_changed_at ON public.landlord_approval_audit(status_changed_at DESC);