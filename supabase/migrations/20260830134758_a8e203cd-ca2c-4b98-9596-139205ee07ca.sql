-- Proxy Agent Directory read-path indexes (no data changes, no policy changes)

-- Activated supporter invites per proxy agent (links CTE)
CREATE INDEX IF NOT EXISTS idx_supporter_invites_creator_activated
  ON public.supporter_invites (created_by)
  WHERE activated_user_id IS NOT NULL;

-- Approved, active supporter assignments per proxy agent (links CTE)
CREATE INDEX IF NOT EXISTS idx_paa_agent_active_supporter
  ON public.proxy_agent_assignments (agent_id, beneficiary_id)
  WHERE is_active AND approval_status = 'approved' AND beneficiary_role = 'supporter';

-- Signed-up proxy partner invites per proxy agent (links CTE)
CREATE INDEX IF NOT EXISTS idx_ppi_agent_signed_up
  ON public.proxy_partner_invites (proxy_agent_id, signed_up_user_id)
  WHERE signed_up_user_id IS NOT NULL;

-- Notes rollup per proxy agent (notes CTE)
CREATE INDEX IF NOT EXISTS idx_promissory_notes_agent_status_amount
  ON public.promissory_notes (agent_id, status);

-- Partner funding rollup (partner_folio CTE)
CREATE INDEX IF NOT EXISTS idx_investor_portfolios_investor_amount
  ON public.investor_portfolios (investor_id)
  WHERE investor_id IS NOT NULL;

-- Wallet commission earnings per proxy agent (earnings CTE)
CREATE INDEX IF NOT EXISTS idx_gl_wallet_cash_in_user_category
  ON public.general_ledger (user_id, category)
  WHERE ledger_scope = 'wallet' AND direction = 'cash_in' AND user_id IS NOT NULL;

-- Status-filtered paging over the proxy agent population
CREATE INDEX IF NOT EXISTS idx_proxy_agent_identity_status_agent
  ON public.proxy_agent_identity (status, agent_user_id);
