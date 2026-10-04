
-- Add agent-managed property fields to landlords table
ALTER TABLE public.landlords 
ADD COLUMN IF NOT EXISTS is_agent_managed boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS managed_by_agent_id uuid,
ADD COLUMN IF NOT EXISTS management_fee_rate numeric DEFAULT 0.02;

-- Create landlord payout requests table
CREATE TABLE public.landlord_payout_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  landlord_id uuid NOT NULL REFERENCES public.landlords(id),
  amount numeric NOT NULL,
  mobile_money_number text NOT NULL,
  mobile_money_provider text NOT NULL CHECK (UPPER(mobile_money_provider) IN ('MTN', 'AIRTEL')),
  property_address text NOT NULL,
  transaction_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'paid')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  approved_by uuid,
  paid_at timestamptz,
  rejection_reason text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.landlord_payout_requests ENABLE ROW LEVEL SECURITY;

-- Agents can see their own payout requests
CREATE POLICY "Agents can view own payout requests"
ON public.landlord_payout_requests
FOR SELECT
TO authenticated
USING (agent_id = auth.uid() OR public.has_role(auth.uid(), 'manager'::app_role));

-- Agents can create payout requests
CREATE POLICY "Agents can create payout requests"
ON public.landlord_payout_requests
FOR INSERT
TO authenticated
WITH CHECK (agent_id = auth.uid());

-- Managers can update payout requests (approve/reject)
CREATE POLICY "Managers can update payout requests"
ON public.landlord_payout_requests
FOR UPDATE
TO authenticated
USING (public.has_role(auth.uid(), 'manager'::app_role));

-- Enable realtime for payout requests
ALTER PUBLICATION supabase_realtime ADD TABLE public.landlord_payout_requests;

-- Trigger to auto-credit 2% management fee to agent when repayment is made for agent-managed property
CREATE OR REPLACE FUNCTION public.credit_agent_management_fee()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_rent_request RECORD;
  v_landlord RECORD;
  v_fee_amount NUMERIC;
BEGIN
  -- Get rent request
  SELECT * INTO v_rent_request FROM public.rent_requests WHERE id = NEW.rent_request_id;
  IF v_rent_request IS NULL THEN RETURN NEW; END IF;

  -- Check if there's an agent-managed landlord for this tenant
  SELECT * INTO v_landlord 
  FROM public.landlords 
  WHERE tenant_id = NEW.tenant_id
  AND is_agent_managed = true
  AND managed_by_agent_id IS NOT NULL
  LIMIT 1;

  IF v_landlord IS NULL THEN RETURN NEW; END IF;

  -- Calculate 2% management fee
  v_fee_amount := NEW.amount * COALESCE(v_landlord.management_fee_rate, 0.02);

  -- Credit agent wallet
  UPDATE public.wallets 
  SET balance = balance + v_fee_amount, updated_at = now()
  WHERE user_id = v_landlord.managed_by_agent_id;

  -- Record earning
  INSERT INTO public.agent_earnings (agent_id, amount, earning_type, source_user_id, description, rent_request_id)
  VALUES (
    v_landlord.managed_by_agent_id,
    v_fee_amount,
    'management_fee',
    NEW.tenant_id,
    '2% property management fee for ' || v_landlord.name,
    NEW.rent_request_id
  );

  -- Notify agent
  INSERT INTO public.notifications (user_id, title, message, type, metadata)
  VALUES (
    v_landlord.managed_by_agent_id,
    '🏠 Management Fee Earned',
    'You earned UGX ' || ROUND(v_fee_amount) || ' management fee for ' || v_landlord.property_address,
    'earning',
    jsonb_build_object('landlord_id', v_landlord.id, 'amount', v_fee_amount, 'tenant_id', NEW.tenant_id)
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_credit_agent_management_fee
AFTER INSERT ON public.repayments
FOR EACH ROW
EXECUTE FUNCTION public.credit_agent_management_fee();

-- Notify managers when payout is requested
CREATE OR REPLACE FUNCTION public.notify_managers_landlord_payout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  manager_record RECORD;
  agent_name TEXT;
BEGIN
  SELECT full_name INTO agent_name FROM public.profiles WHERE id = NEW.agent_id;
  
  FOR manager_record IN SELECT user_id FROM public.user_roles WHERE role = 'manager'
  LOOP
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      manager_record.user_id,
      '🏠 Landlord Payout Request',
      COALESCE(agent_name, 'An agent') || ' requests UGX ' || NEW.amount || ' payout to landlord at ' || NEW.property_address,
      'info',
      jsonb_build_object('payout_request_id', NEW.id, 'agent_id', NEW.agent_id, 'amount', NEW.amount)
    );
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notify_managers_landlord_payout
AFTER INSERT ON public.landlord_payout_requests
FOR EACH ROW
EXECUTE FUNCTION public.notify_managers_landlord_payout();
