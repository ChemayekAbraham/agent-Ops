CREATE TABLE public.gmail_reconnect_audit (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('verify','reconnect_initiated')),
  outcome TEXT NOT NULL CHECK (outcome IN ('verified','skipped','failed','initiated','error')),
  latency_ms INTEGER,
  error_message TEXT,
  raw_response JSONB,
  initiated_by UUID,
  initiated_by_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_gmail_reconnect_audit_created_at ON public.gmail_reconnect_audit(created_at DESC);

ALTER TABLE public.gmail_reconnect_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Privileged staff can view gmail reconnect audit"
ON public.gmail_reconnect_audit
FOR SELECT
USING (
  has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
);

CREATE POLICY "Privileged staff can insert gmail reconnect audit"
ON public.gmail_reconnect_audit
FOR INSERT
WITH CHECK (
  has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
);