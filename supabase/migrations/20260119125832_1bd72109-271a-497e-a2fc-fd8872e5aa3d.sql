-- Create table to track agent-subagent relationships
CREATE TABLE public.agent_subagents (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    parent_agent_id UUID NOT NULL,
    sub_agent_id UUID NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT unique_subagent UNIQUE (sub_agent_id)
);

-- Enable RLS
ALTER TABLE public.agent_subagents ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Agents can view their own subagents"
ON public.agent_subagents
FOR SELECT
USING (auth.uid() = parent_agent_id OR auth.uid() = sub_agent_id);

CREATE POLICY "Agents can insert subagents they create"
ON public.agent_subagents
FOR INSERT
WITH CHECK (auth.uid() = parent_agent_id);

-- Create or replace function to credit agent commission with subagent logic
-- Sub-agents earn 4% of rent repayments
-- Parent agents earn 1% of their subagents' tenants repayments
CREATE OR REPLACE FUNCTION public.credit_agent_repayment_commission()
RETURNS TRIGGER AS $$
DECLARE
  tenant_agent_id UUID;
  parent_agent_id UUID;
  commission_rate NUMERIC;
  parent_commission_rate NUMERIC := 0.01; -- 1% for parent agent
  sub_agent_commission_rate NUMERIC := 0.04; -- 4% for sub-agents
  regular_agent_commission_rate NUMERIC := 0.05; -- 5% for regular agents
  commission_amount NUMERIC;
  parent_commission_amount NUMERIC;
  is_sub_agent BOOLEAN := FALSE;
BEGIN
  -- Find the agent who registered this tenant
  SELECT agent_id INTO tenant_agent_id
  FROM rent_requests
  WHERE tenant_id = NEW.tenant_id
  ORDER BY created_at ASC
  LIMIT 1;
  
  -- If no agent found via rent_requests, check referrals
  IF tenant_agent_id IS NULL THEN
    SELECT referrer_id INTO tenant_agent_id
    FROM referrals
    WHERE referred_id = NEW.tenant_id
    LIMIT 1;
  END IF;
  
  -- If no agent found, exit
  IF tenant_agent_id IS NULL THEN
    RETURN NEW;
  END IF;
  
  -- Check if this agent is a sub-agent
  SELECT parent_agent_id INTO parent_agent_id
  FROM agent_subagents
  WHERE sub_agent_id = tenant_agent_id;
  
  IF parent_agent_id IS NOT NULL THEN
    is_sub_agent := TRUE;
    commission_rate := sub_agent_commission_rate; -- 4% for sub-agent
  ELSE
    commission_rate := regular_agent_commission_rate; -- 5% for regular agent
  END IF;
  
  commission_amount := NEW.amount * commission_rate;
  
  -- Credit the agent (sub-agent or regular)
  INSERT INTO agent_earnings (agent_id, amount, earning_type, description, source_user_id, rent_request_id)
  VALUES (
    tenant_agent_id,
    commission_amount,
    'commission',
    CASE WHEN is_sub_agent 
      THEN '4% commission on tenant repayment'
      ELSE '5% commission on tenant repayment'
    END,
    NEW.tenant_id,
    NEW.rent_request_id
  );
  
  -- Credit agent wallet
  UPDATE wallets SET balance = balance + commission_amount, updated_at = now()
  WHERE user_id = tenant_agent_id;
  
  -- If agent is a sub-agent, also credit parent agent 1%
  IF is_sub_agent AND parent_agent_id IS NOT NULL THEN
    parent_commission_amount := NEW.amount * parent_commission_rate;
    
    INSERT INTO agent_earnings (agent_id, amount, earning_type, description, source_user_id, rent_request_id)
    VALUES (
      parent_agent_id,
      parent_commission_amount,
      'subagent_commission',
      '1% commission from subagent tenant repayment',
      NEW.tenant_id,
      NEW.rent_request_id
    );
    
    -- Credit parent agent wallet
    UPDATE wallets SET balance = balance + parent_commission_amount, updated_at = now()
    WHERE user_id = parent_agent_id;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Drop existing trigger if exists and create new one
DROP TRIGGER IF EXISTS on_repayment_agent_commission ON repayments;
CREATE TRIGGER on_repayment_agent_commission
AFTER INSERT ON repayments
FOR EACH ROW
EXECUTE FUNCTION credit_agent_repayment_commission();

-- Enable realtime for agent_subagents
ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_subagents;