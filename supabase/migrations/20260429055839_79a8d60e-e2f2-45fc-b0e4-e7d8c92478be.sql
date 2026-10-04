CREATE TABLE public.agent_proxy_card_dismissals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  partner_id UUID NOT NULL,
  portfolio_id UUID,
  snapshot_amount NUMERIC NOT NULL DEFAULT 0,
  reason TEXT,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_proxy_card_dismissals_unique UNIQUE (agent_id, partner_id, portfolio_id)
);

CREATE INDEX idx_apcd_agent ON public.agent_proxy_card_dismissals(agent_id);

ALTER TABLE public.agent_proxy_card_dismissals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_select_own_dismissals"
  ON public.agent_proxy_card_dismissals FOR SELECT
  USING (agent_id = auth.uid());

CREATE POLICY "agent_insert_own_dismissals"
  ON public.agent_proxy_card_dismissals FOR INSERT
  WITH CHECK (agent_id = auth.uid());

CREATE POLICY "agent_update_own_dismissals"
  ON public.agent_proxy_card_dismissals FOR UPDATE
  USING (agent_id = auth.uid());

CREATE POLICY "agent_delete_own_dismissals"
  ON public.agent_proxy_card_dismissals FOR DELETE
  USING (agent_id = auth.uid());