-- Ensure agent_ops_* columns exist (added in prior migration; safe re-create)
ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS agent_ops_comment text,
  ADD COLUMN IF NOT EXISTS agent_ops_reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS agent_ops_reviewed_at timestamp with time zone;

-- One-shot in-flight migration to the new 5-stage flow
-- (Tenant Ops -> Landlord Ops -> Agent Ops -> CFO  becomes
--  Agent Ops -> Tenant Ops -> Landlord Ops -> COO -> CFO)

-- Old "Agent Verification" queue (status=tenant_ops_approved) → split
UPDATE public.rent_requests
   SET status = 'agent_ops_approved',
       updated_at = now()
 WHERE status = 'tenant_ops_approved'
   AND assigned_agent_id IS NOT NULL;

UPDATE public.rent_requests
   SET status = 'pending',
       updated_at = now()
 WHERE status = 'tenant_ops_approved'
   AND assigned_agent_id IS NULL;

-- Old "Landlord Ops" queue (status=agent_verified) → new Landlord Ops queue (tenant_ops_approved)
UPDATE public.rent_requests
   SET status = 'tenant_ops_approved',
       updated_at = now()
 WHERE status = 'agent_verified';

-- landlord_ops_approved (was COO queue) and coo_approved (was CFO queue) keep their status.