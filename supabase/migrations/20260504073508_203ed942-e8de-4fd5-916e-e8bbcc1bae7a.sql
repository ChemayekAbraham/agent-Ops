ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS tenant_ops_comment text,
  ADD COLUMN IF NOT EXISTS landlord_ops_comment text,
  ADD COLUMN IF NOT EXISTS agent_ops_comment text,
  ADD COLUMN IF NOT EXISTS agent_ops_reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS agent_ops_reviewed_at timestamp with time zone;