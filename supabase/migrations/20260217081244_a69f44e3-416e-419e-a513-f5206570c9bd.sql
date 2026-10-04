
-- Table for agent-recorded tenant merchant payments
CREATE TABLE public.tenant_merchant_payments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID NOT NULL,
  tenant_id UUID,
  tenant_phone TEXT,
  transaction_id TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  merchant_name TEXT NOT NULL,
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.tenant_merchant_payments ENABLE ROW LEVEL SECURITY;

-- Agents can insert their own records
CREATE POLICY "Agents can insert their own payment records"
  ON public.tenant_merchant_payments FOR INSERT
  WITH CHECK (auth.uid() = agent_id);

-- Agents can view their own records
CREATE POLICY "Agents can view their own payment records"
  ON public.tenant_merchant_payments FOR SELECT
  USING (auth.uid() = agent_id);

-- Managers can view all records
CREATE POLICY "Managers can view all payment records"
  ON public.tenant_merchant_payments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'manager' AND enabled = true
    )
  );

-- Trigger for updated_at
CREATE TRIGGER update_tenant_merchant_payments_updated_at
  BEFORE UPDATE ON public.tenant_merchant_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
