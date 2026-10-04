ALTER TABLE public.withdrawal_requests
  DROP CONSTRAINT IF EXISTS withdrawal_requests_assigned_cashout_agent_id_fkey,
  ADD CONSTRAINT withdrawal_requests_assigned_cashout_agent_id_fkey
    FOREIGN KEY (assigned_cashout_agent_id)
    REFERENCES public.cashout_agents(id)
    ON DELETE SET NULL;

ALTER TABLE public.withdrawal_requests
  DROP CONSTRAINT IF EXISTS withdrawal_requests_preferred_cashout_agent_id_fkey,
  ADD CONSTRAINT withdrawal_requests_preferred_cashout_agent_id_fkey
    FOREIGN KEY (preferred_cashout_agent_id)
    REFERENCES public.cashout_agents(id)
    ON DELETE SET NULL;