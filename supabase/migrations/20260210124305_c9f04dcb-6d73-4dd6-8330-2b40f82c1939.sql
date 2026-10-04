
-- Add tenant meter numbers to rent_requests
ALTER TABLE public.rent_requests 
  ADD COLUMN IF NOT EXISTS tenant_water_meter TEXT,
  ADD COLUMN IF NOT EXISTS tenant_electricity_meter TEXT;

-- Add landlord verification fields (TIN, system-generated PINs)
ALTER TABLE public.landlords
  ADD COLUMN IF NOT EXISTS tin TEXT,
  ADD COLUMN IF NOT EXISTS verification_pin_1 TEXT,
  ADD COLUMN IF NOT EXISTS verification_pin_2 TEXT;

-- Agent verification submissions table (what the agent entered)
CREATE TABLE public.agent_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id UUID NOT NULL REFERENCES public.rent_requests(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL,
  landlord_id UUID NOT NULL REFERENCES public.landlords(id),
  -- Agent-submitted values
  submitted_pin_1 TEXT NOT NULL,
  submitted_pin_2 TEXT NOT NULL,
  submitted_tin TEXT,
  submitted_landlord_water_meter TEXT,
  submitted_landlord_electricity_meter TEXT,
  submitted_tenant_water_meter TEXT,
  submitted_tenant_electricity_meter TEXT,
  -- Match results
  pin_1_match BOOLEAN DEFAULT false,
  pin_2_match BOOLEAN DEFAULT false,
  tin_match BOOLEAN,
  landlord_water_match BOOLEAN,
  landlord_electricity_match BOOLEAN,
  tenant_water_match BOOLEAN,
  tenant_electricity_match BOOLEAN,
  overall_match BOOLEAN DEFAULT false,
  -- Status
  verified_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(rent_request_id, agent_id)
);

ALTER TABLE public.agent_verifications ENABLE ROW LEVEL SECURITY;

-- Agents can insert their own verifications
CREATE POLICY "Agents can submit verifications"
ON public.agent_verifications FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = agent_id);

-- Agents and managers can view verifications
CREATE POLICY "Authenticated users can view verifications"
ON public.agent_verifications FOR SELECT
TO authenticated
USING (true);

-- Function to generate random 4-digit PINs for landlord on creation
CREATE OR REPLACE FUNCTION public.generate_landlord_pins()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.verification_pin_1 IS NULL THEN
    NEW.verification_pin_1 := LPAD(floor(random() * 10000)::text, 4, '0');
  END IF;
  IF NEW.verification_pin_2 IS NULL THEN
    NEW.verification_pin_2 := LPAD(floor(random() * 10000)::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_generate_landlord_pins
BEFORE INSERT ON public.landlords
FOR EACH ROW
EXECUTE FUNCTION public.generate_landlord_pins();

-- Generate PINs for existing landlords that don't have them
UPDATE public.landlords 
SET verification_pin_1 = LPAD(floor(random() * 10000)::text, 4, '0'),
    verification_pin_2 = LPAD(floor(random() * 10000)::text, 4, '0')
WHERE verification_pin_1 IS NULL;

-- Function to notify all agents when a rent request has no agent
CREATE OR REPLACE FUNCTION public.notify_agents_unverified_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_name TEXT;
  v_agent RECORD;
BEGIN
  -- Only trigger if no agent assigned
  IF NEW.agent_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT full_name INTO v_tenant_name FROM public.profiles WHERE id = NEW.tenant_id;

  -- Notify all agents
  FOR v_agent IN 
    SELECT ur.user_id FROM public.user_roles ur WHERE ur.role = 'agent'
  LOOP
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      v_agent.user_id,
      'Verification Opportunity',
      'Tenant ' || COALESCE(v_tenant_name, 'Unknown') || ' needs location and landlord verification. Earn UGX 10,000!',
      'verification_opportunity',
      jsonb_build_object('rent_request_id', NEW.id, 'tenant_id', NEW.tenant_id)
    );
  END LOOP;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notify_agents_unverified
AFTER INSERT ON public.rent_requests
FOR EACH ROW
EXECUTE FUNCTION public.notify_agents_unverified_tenant();

-- Function: Agent earns UGX 10,000 when landlord receives rent (fund_routed_at is set)
CREATE OR REPLACE FUNCTION public.credit_agent_verification_bonus()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent_id UUID;
  v_already_paid BOOLEAN;
BEGIN
  -- Only when fund_routed_at changes from NULL to a value
  IF OLD.fund_routed_at IS NOT NULL OR NEW.fund_routed_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- Get the agent who verified this request
  SELECT agent_id INTO v_agent_id FROM public.agent_verifications 
  WHERE rent_request_id = NEW.id AND overall_match = true
  LIMIT 1;

  IF v_agent_id IS NULL THEN
    -- Fallback to request's agent_id
    v_agent_id := NEW.agent_id;
  END IF;

  IF v_agent_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Check if bonus already paid
  SELECT EXISTS (
    SELECT 1 FROM public.agent_earnings 
    WHERE agent_id = v_agent_id AND rent_request_id = NEW.id AND earning_type = 'verification_bonus'
  ) INTO v_already_paid;

  IF v_already_paid THEN
    RETURN NEW;
  END IF;

  -- Credit UGX 10,000 to agent wallet
  UPDATE public.wallets SET balance = balance + 10000 WHERE user_id = v_agent_id;

  -- Record earning
  INSERT INTO public.agent_earnings (agent_id, amount, earning_type, rent_request_id, description)
  VALUES (v_agent_id, 10000, 'verification_bonus', NEW.id, 'Verification bonus - landlord received rent');

  -- Notify agent
  INSERT INTO public.notifications (user_id, title, message, type)
  VALUES (v_agent_id, 'Verification Bonus!', 'You earned UGX 10,000 for verifying a tenant whose landlord has received rent.', 'earning');

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_credit_verification_bonus
AFTER UPDATE ON public.rent_requests
FOR EACH ROW
EXECUTE FUNCTION public.credit_agent_verification_bonus();
