CREATE INDEX IF NOT EXISTS idx_rent_requests_assigned_agent_id
ON public.rent_requests (assigned_agent_id)
WHERE assigned_agent_id IS NOT NULL;