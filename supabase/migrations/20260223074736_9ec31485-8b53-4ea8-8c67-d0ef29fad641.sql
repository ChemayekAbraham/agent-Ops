
-- Table to track scheduled wallet auto-charges for subscribed services
CREATE TABLE public.subscription_charges (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL,
  rent_request_id UUID REFERENCES public.rent_requests(id),
  service_type TEXT NOT NULL DEFAULT 'rent_facilitation',
  charge_amount NUMERIC NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  next_charge_date DATE NOT NULL,
  start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date DATE,
  total_charges_due NUMERIC NOT NULL DEFAULT 0,
  total_charged NUMERIC NOT NULL DEFAULT 0,
  accumulated_debt NUMERIC NOT NULL DEFAULT 0,
  charges_completed INTEGER NOT NULL DEFAULT 0,
  charges_remaining INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Table to log each individual charge attempt
CREATE TABLE public.subscription_charge_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  subscription_id UUID NOT NULL REFERENCES public.subscription_charges(id),
  tenant_id UUID NOT NULL,
  charge_amount NUMERIC NOT NULL,
  amount_deducted NUMERIC NOT NULL DEFAULT 0,
  debt_added NUMERIC NOT NULL DEFAULT 0,
  wallet_balance_before NUMERIC,
  wallet_balance_after NUMERIC,
  status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'insufficient_funds', 'failed')),
  charge_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.subscription_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_charge_logs ENABLE ROW LEVEL SECURITY;

-- RLS for subscription_charges
CREATE POLICY "Tenants can view own subscriptions"
  ON public.subscription_charges FOR SELECT
  USING (auth.uid() = tenant_id);

CREATE POLICY "Managers can view all subscriptions"
  ON public.subscription_charges FOR SELECT
  USING (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "System can insert subscriptions"
  ON public.subscription_charges FOR INSERT
  WITH CHECK (true);

CREATE POLICY "System can update subscriptions"
  ON public.subscription_charges FOR UPDATE
  USING (true);

CREATE POLICY "Managers can update subscriptions"
  ON public.subscription_charges FOR UPDATE
  USING (has_role(auth.uid(), 'manager'::app_role));

-- RLS for subscription_charge_logs
CREATE POLICY "Tenants can view own charge logs"
  ON public.subscription_charge_logs FOR SELECT
  USING (auth.uid() = tenant_id);

CREATE POLICY "Managers can view all charge logs"
  ON public.subscription_charge_logs FOR SELECT
  USING (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "System can insert charge logs"
  ON public.subscription_charge_logs FOR INSERT
  WITH CHECK (true);

-- Indexes for performance
CREATE INDEX idx_subscription_charges_tenant ON public.subscription_charges(tenant_id);
CREATE INDEX idx_subscription_charges_status ON public.subscription_charges(status, next_charge_date);
CREATE INDEX idx_subscription_charges_rent_request ON public.subscription_charges(rent_request_id);
CREATE INDEX idx_charge_logs_subscription ON public.subscription_charge_logs(subscription_id);
CREATE INDEX idx_charge_logs_tenant ON public.subscription_charge_logs(tenant_id);

-- Trigger for updated_at
CREATE TRIGGER update_subscription_charges_updated_at
  BEFORE UPDATE ON public.subscription_charges
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Enable realtime for manager monitoring
ALTER PUBLICATION supabase_realtime ADD TABLE public.subscription_charges;
