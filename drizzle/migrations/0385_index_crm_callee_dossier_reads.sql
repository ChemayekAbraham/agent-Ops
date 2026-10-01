CREATE INDEX IF NOT EXISTS idx_agent_collections_agent_live_created
  ON public.agent_collections (agent_id, created_at DESC)
  WHERE reversed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_collections_tenant_live_created
  ON public.agent_collections (tenant_id, created_at DESC)
  WHERE reversed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_repayments_tenant_created
  ON public.repayments (tenant_id, created_at DESC);