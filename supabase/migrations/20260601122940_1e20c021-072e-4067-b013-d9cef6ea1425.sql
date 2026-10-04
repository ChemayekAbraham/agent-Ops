CREATE TABLE public.agent_cash_deposit_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  depositor_id uuid NOT NULL,
  depositor_name text,
  agent_id uuid NOT NULL,
  agent_phone text NOT NULL,
  amount numeric NOT NULL,
  pin text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  deposit_request_id uuid,
  ledger_txn_group uuid,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.agent_cash_deposit_sessions TO authenticated;
GRANT ALL ON public.agent_cash_deposit_sessions TO service_role;

ALTER TABLE public.agent_cash_deposit_sessions ENABLE ROW LEVEL SECURITY;

-- Only the targeted agent may read their own pending/recent sessions so the
-- 4-digit code surfaces ONLY on that agent's dashboard. The depositor never
-- reads the code client-side (they confirm via an edge function).
CREATE POLICY "Agent can view own cash deposit sessions"
ON public.agent_cash_deposit_sessions
FOR SELECT
TO authenticated
USING (agent_id = auth.uid());

CREATE INDEX idx_agent_cash_sessions_agent_status
  ON public.agent_cash_deposit_sessions(agent_id, status);
CREATE INDEX idx_agent_cash_sessions_depositor
  ON public.agent_cash_deposit_sessions(depositor_id, status);

-- Live updates so the code appears instantly on the agent dashboard.
ALTER TABLE public.agent_cash_deposit_sessions REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_cash_deposit_sessions;