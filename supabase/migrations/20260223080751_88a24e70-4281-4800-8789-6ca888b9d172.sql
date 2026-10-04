-- Add agent_id to subscription_charges so we know which agent to fall back to
ALTER TABLE public.subscription_charges 
ADD COLUMN agent_id uuid,
ADD COLUMN agent_charged_amount numeric NOT NULL DEFAULT 0,
ADD COLUMN agent_charge_count integer NOT NULL DEFAULT 0;

-- Comment for clarity
COMMENT ON COLUMN public.subscription_charges.agent_id IS 'The agent/sub-agent responsible for this tenant - charged if tenant has insufficient funds';
COMMENT ON COLUMN public.subscription_charges.agent_charged_amount IS 'Total amount charged to the agent on behalf of the tenant';
COMMENT ON COLUMN public.subscription_charges.agent_charge_count IS 'Number of times the agent was charged for this subscription';
