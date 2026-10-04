
-- Agent Landlord Float: ring-fenced escrow balance for landlord payments
CREATE TABLE public.agent_landlord_float (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  balance NUMERIC NOT NULL DEFAULT 0 CHECK (balance >= 0),
  total_funded NUMERIC NOT NULL DEFAULT 0,
  total_paid_out NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(agent_id)
);

-- Float funding records (CFO/Manager credits)
CREATE TABLE public.agent_float_funding (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  funded_by UUID NOT NULL REFERENCES public.profiles(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Float withdrawal requests (agent pays landlord from float)
CREATE TABLE public.agent_float_withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  rent_request_id UUID NOT NULL REFERENCES public.rent_requests(id),
  landlord_id UUID NOT NULL REFERENCES public.landlords(id),
  tenant_id UUID NOT NULL REFERENCES public.profiles(id),
  amount NUMERIC NOT NULL CHECK (amount > 0),
  landlord_name TEXT NOT NULL,
  landlord_phone TEXT NOT NULL,
  mobile_money_provider TEXT NOT NULL,
  transaction_id TEXT,
  receipt_photo_urls TEXT[],
  -- Agent GPS at time of payout
  agent_latitude NUMERIC,
  agent_longitude NUMERIC,
  agent_location_accuracy NUMERIC,
  -- Landlord/property GPS captured during payout
  landlord_latitude NUMERIC,
  landlord_longitude NUMERIC,
  landlord_location_accuracy NUMERIC,
  -- Property reference GPS
  property_latitude NUMERIC,
  property_longitude NUMERIC,
  -- GPS comparison
  gps_match BOOLEAN DEFAULT false,
  gps_distance_meters NUMERIC,
  -- Approval
  status TEXT NOT NULL DEFAULT 'pending_agent_ops' CHECK (status IN ('pending_agent_ops','agent_ops_approved','agent_ops_rejected','cfo_approved','cfo_rejected','completed')),
  agent_ops_reviewed_by UUID REFERENCES public.profiles(id),
  agent_ops_reviewed_at TIMESTAMPTZ,
  agent_ops_notes TEXT,
  manager_reviewed_by UUID REFERENCES public.profiles(id),
  manager_reviewed_at TIMESTAMPTZ,
  manager_notes TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.agent_landlord_float ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_float_funding ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_float_withdrawals ENABLE ROW LEVEL SECURITY;

-- Agents see own float
CREATE POLICY "Agents see own float" ON public.agent_landlord_float
  FOR SELECT TO authenticated USING (agent_id = auth.uid());

-- Managers/staff see all floats
CREATE POLICY "Staff see all floats" ON public.agent_landlord_float
  FOR SELECT TO authenticated USING (
    public.has_role(auth.uid(), 'manager') OR
    public.has_role(auth.uid(), 'super_admin') OR
    public.has_role(auth.uid(), 'cfo') OR
    public.has_role(auth.uid(), 'operations')
  );

-- Staff can insert/update floats
CREATE POLICY "Staff manage floats" ON public.agent_landlord_float
  FOR ALL TO authenticated USING (
    public.has_role(auth.uid(), 'manager') OR
    public.has_role(auth.uid(), 'cfo') OR
    public.has_role(auth.uid(), 'super_admin')
  );

-- Float funding
CREATE POLICY "Agents see own funding" ON public.agent_float_funding
  FOR SELECT TO authenticated USING (agent_id = auth.uid());

CREATE POLICY "Staff see all funding" ON public.agent_float_funding
  FOR SELECT TO authenticated USING (
    public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'operations')
  );

CREATE POLICY "Staff insert funding" ON public.agent_float_funding
  FOR INSERT TO authenticated WITH CHECK (
    public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'super_admin')
  );

-- Float withdrawals
CREATE POLICY "Agents see own withdrawals" ON public.agent_float_withdrawals
  FOR SELECT TO authenticated USING (agent_id = auth.uid());

CREATE POLICY "Agents insert withdrawals" ON public.agent_float_withdrawals
  FOR INSERT TO authenticated WITH CHECK (agent_id = auth.uid());

CREATE POLICY "Staff see all withdrawals" ON public.agent_float_withdrawals
  FOR SELECT TO authenticated USING (
    public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'operations')
  );

CREATE POLICY "Staff update withdrawals" ON public.agent_float_withdrawals
  FOR UPDATE TO authenticated USING (
    public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'operations')
  );

-- Trigger: auto-deduct float on withdrawal insert
CREATE OR REPLACE FUNCTION public.deduct_float_on_withdrawal()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.agent_landlord_float
  SET balance = balance - NEW.amount,
      total_paid_out = total_paid_out + NEW.amount,
      updated_at = now()
  WHERE agent_id = NEW.agent_id AND balance >= NEW.amount;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient landlord float balance';
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_deduct_float_on_withdrawal
  BEFORE INSERT ON public.agent_float_withdrawals
  FOR EACH ROW EXECUTE FUNCTION public.deduct_float_on_withdrawal();

-- Trigger: credit float on funding insert
CREATE OR REPLACE FUNCTION public.credit_float_on_funding()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.agent_landlord_float (agent_id, balance, total_funded)
  VALUES (NEW.agent_id, NEW.amount, NEW.amount)
  ON CONFLICT (agent_id) DO UPDATE SET
    balance = agent_landlord_float.balance + NEW.amount,
    total_funded = agent_landlord_float.total_funded + NEW.amount,
    updated_at = now();
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_credit_float_on_funding
  AFTER INSERT ON public.agent_float_funding
  FOR EACH ROW EXECUTE FUNCTION public.credit_float_on_funding();
