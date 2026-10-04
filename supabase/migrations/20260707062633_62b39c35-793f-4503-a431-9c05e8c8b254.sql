ALTER TABLE public.cashout_agents
  ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.cashout_agents.config IS 'CFO-managed permission matrix: authorized payout categories, float permissions, transaction limits, approval rules, networks, banks, security, operational assignment, and status.';