CREATE TABLE public.house_assignment_audit (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  house_listing_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  invite_id uuid,
  assigned_by_user_id uuid,
  assigned_by_role text,
  listing_agent_id uuid,
  placement_bonus_status text NOT NULL DEFAULT 'unknown',
  placement_bonus_paid_at timestamptz,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_house_assignment_audit_house ON public.house_assignment_audit(house_listing_id);
CREATE INDEX idx_house_assignment_audit_tenant ON public.house_assignment_audit(tenant_id);
CREATE INDEX idx_house_assignment_audit_assigned_by ON public.house_assignment_audit(assigned_by_user_id);
CREATE INDEX idx_house_assignment_audit_agent ON public.house_assignment_audit(listing_agent_id);

GRANT SELECT ON public.house_assignment_audit TO authenticated;
GRANT ALL ON public.house_assignment_audit TO service_role;

ALTER TABLE public.house_assignment_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops roles can view all house assignment audits"
ON public.house_assignment_audit
FOR SELECT
TO authenticated
USING (public.is_ops_role(auth.uid()));

CREATE POLICY "Involved users can view their house assignment audits"
ON public.house_assignment_audit
FOR SELECT
TO authenticated
USING (
  auth.uid() = assigned_by_user_id
  OR auth.uid() = listing_agent_id
  OR auth.uid() = tenant_id
);