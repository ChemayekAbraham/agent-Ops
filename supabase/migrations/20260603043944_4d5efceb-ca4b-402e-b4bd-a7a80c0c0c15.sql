-- Audit trail for every deposit matcher/poller decision and every approval rejection.
CREATE TABLE public.deposit_decision_audit (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  deposit_request_id uuid,
  gmail_transaction_id uuid,
  source text NOT NULL,            -- 'matcher' | 'poller' | 'approval'
  decision text NOT NULL,          -- 'approved' | 'rejected' | 'blocked' | 'skipped' | 'auto_credited' | 'failed' | 'matched'
  reason text,                     -- e.g. 'cash_code_required', 'auto_approve_unverified'
  amount numeric,
  actor_id uuid,
  actor_email text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_deposit_decision_audit_deposit ON public.deposit_decision_audit (deposit_request_id);
CREATE INDEX idx_deposit_decision_audit_created ON public.deposit_decision_audit (created_at DESC);
CREATE INDEX idx_deposit_decision_audit_source_decision ON public.deposit_decision_audit (source, decision);
CREATE INDEX idx_deposit_decision_audit_reason ON public.deposit_decision_audit (reason);

-- Edge functions (service_role) are the only writers. Ops/finance roles read.
GRANT SELECT ON public.deposit_decision_audit TO authenticated;
GRANT ALL ON public.deposit_decision_audit TO service_role;

ALTER TABLE public.deposit_decision_audit ENABLE ROW LEVEL SECURITY;

-- Only oversight roles may read the audit trail.
CREATE POLICY "Oversight roles can read deposit decision audit"
ON public.deposit_decision_audit
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'operations')
  OR public.has_role(auth.uid(), 'super_admin')
);
