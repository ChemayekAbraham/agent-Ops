CREATE INDEX IF NOT EXISTS idx_rent_requests_tenant_created
  ON public.rent_requests (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rent_requests_assigned_agent_active
  ON public.rent_requests (assigned_agent_id)
  WHERE status IN ('funded', 'repaying');

CREATE INDEX IF NOT EXISTS idx_general_ledger_user_scope_created
  ON public.general_ledger (user_id, ledger_scope, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_promissory_notes_agent_created
  ON public.promissory_notes (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_proxy_agent_assignments_beneficiary
  ON public.proxy_agent_assignments (beneficiary_id);

CREATE INDEX IF NOT EXISTS idx_partner_self_topups_partner_created
  ON public.partner_self_topups (partner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_portfolio_change_log_partner_changed
  ON public.portfolio_change_log (partner_id, changed_at DESC);