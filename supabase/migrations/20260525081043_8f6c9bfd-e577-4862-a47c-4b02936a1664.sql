-- ============================================================
-- investor_portfolios — Partner Ops + Funder dashboards
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_investor_portfolios_investor_status
  ON public.investor_portfolios (investor_id, status);

CREATE INDEX IF NOT EXISTS idx_investor_portfolios_agent_status
  ON public.investor_portfolios (agent_id, status)
  WHERE agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_investor_portfolios_next_roi_date
  ON public.investor_portfolios (next_roi_date)
  WHERE status = 'active' AND next_roi_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_investor_portfolios_status_created
  ON public.investor_portfolios (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_investor_portfolios_cfo_pending
  ON public.investor_portfolios (created_at DESC)
  WHERE cfo_verified = false;

CREATE INDEX IF NOT EXISTS idx_investor_portfolios_maturity
  ON public.investor_portfolios (maturity_date)
  WHERE status = 'active';

-- ============================================================
-- general_ledger — wallet pivot + per-user history
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_general_ledger_user_classification_created
  ON public.general_ledger (user_id, classification, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_general_ledger_wallet_scope_user_created
  ON public.general_ledger (user_id, created_at DESC)
  WHERE ledger_scope = 'wallet';

CREATE INDEX IF NOT EXISTS idx_general_ledger_user_category_created
  ON public.general_ledger (user_id, category, created_at DESC)
  WHERE user_id IS NOT NULL;

-- ============================================================
-- profiles — Partner Ops list / agent fleet / lookups
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_profiles_managing_agent_created
  ON public.profiles (managing_agent_id, created_at DESC)
  WHERE managing_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_referrer_created
  ON public.profiles (referrer_id, created_at DESC)
  WHERE referrer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_signup_source_created
  ON public.profiles (signup_source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_profiles_national_id_lookup
  ON public.profiles (national_id)
  WHERE national_id IS NOT NULL AND national_id <> '';

-- ============================================================
-- agent_advances — open balance lookups per agent
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_agent_advances_agent_status_created
  ON public.agent_advances (agent_id, status, created_at DESC);

-- ============================================================
-- audit_logs / system_events — recent activity per user
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created
  ON public.audit_logs (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_table_record_created
  ON public.audit_logs (table_name, record_id, created_at DESC)
  WHERE table_name IS NOT NULL AND record_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_system_events_user_created
  ON public.system_events (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_system_events_type_created
  ON public.system_events (event_type, created_at DESC);

-- Refresh planner stats on the affected tables
ANALYZE public.investor_portfolios;
ANALYZE public.general_ledger;
ANALYZE public.profiles;
ANALYZE public.agent_advances;
ANALYZE public.audit_logs;
ANALYZE public.system_events;