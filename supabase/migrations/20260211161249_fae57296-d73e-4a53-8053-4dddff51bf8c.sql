
-- Create dedicated general_ledger table for scalable financial reads
CREATE TABLE public.general_ledger (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  transaction_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  amount NUMERIC NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('cash_in', 'cash_out')),
  category TEXT NOT NULL,
  description TEXT,
  reference_id TEXT,
  user_id UUID,
  linked_party TEXT,
  source_table TEXT NOT NULL,
  source_id UUID,
  running_balance NUMERIC DEFAULT 0
);

-- Indexes for fast queries
CREATE INDEX idx_general_ledger_created_at ON public.general_ledger (created_at DESC);
CREATE INDEX idx_general_ledger_category ON public.general_ledger (category);
CREATE INDEX idx_general_ledger_direction ON public.general_ledger (direction);
CREATE INDEX idx_general_ledger_source ON public.general_ledger (source_table, source_id);
CREATE INDEX idx_general_ledger_user_id ON public.general_ledger (user_id);
CREATE INDEX idx_general_ledger_composite ON public.general_ledger (created_at DESC, category, direction);

-- Enable RLS
ALTER TABLE public.general_ledger ENABLE ROW LEVEL SECURITY;

-- Managers can read all ledger entries
CREATE POLICY "Managers can view all ledger entries"
ON public.general_ledger FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = auth.uid()
    AND user_roles.role = 'manager'
  )
);

-- Users can view their own ledger entries
CREATE POLICY "Users can view own ledger entries"
ON public.general_ledger FOR SELECT
USING (auth.uid() = user_id);

-- Only system (triggers) can insert
CREATE POLICY "System can insert ledger entries"
ON public.general_ledger FOR INSERT
WITH CHECK (true);

-- Trigger function to auto-compute running balance
CREATE OR REPLACE FUNCTION public.compute_ledger_running_balance()
RETURNS TRIGGER AS $$
DECLARE
  last_balance NUMERIC;
BEGIN
  SELECT COALESCE(running_balance, 0) INTO last_balance
  FROM public.general_ledger
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  IF NEW.direction = 'cash_in' THEN
    NEW.running_balance := COALESCE(last_balance, 0) + NEW.amount;
  ELSE
    NEW.running_balance := COALESCE(last_balance, 0) - NEW.amount;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_ledger_running_balance
BEFORE INSERT ON public.general_ledger
FOR EACH ROW
EXECUTE FUNCTION public.compute_ledger_running_balance();

-- Auto-insert trigger for platform_transactions
CREATE OR REPLACE FUNCTION public.log_platform_transaction_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.general_ledger (
    transaction_date, amount, direction, category, description,
    user_id, source_table, source_id
  ) VALUES (
    NEW.created_at,
    NEW.amount,
    CASE WHEN NEW.direction = 'cash_in' THEN 'cash_in' ELSE 'cash_out' END,
    NEW.transaction_type,
    NEW.description,
    NEW.user_id,
    'platform_transactions',
    NEW.id
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_platform_tx_to_ledger
AFTER INSERT ON public.platform_transactions
FOR EACH ROW
EXECUTE FUNCTION public.log_platform_transaction_to_ledger();

-- Auto-insert trigger for agent_earnings
CREATE OR REPLACE FUNCTION public.log_agent_earning_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.general_ledger (
    transaction_date, amount, direction, category, description,
    user_id, source_table, source_id
  ) VALUES (
    NEW.created_at,
    NEW.amount,
    'cash_out',
    'agent_commission',
    NEW.description,
    NEW.agent_id,
    'agent_earnings',
    NEW.id
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_agent_earning_to_ledger
AFTER INSERT ON public.agent_earnings
FOR EACH ROW
EXECUTE FUNCTION public.log_agent_earning_to_ledger();

-- Auto-insert trigger for deposit_requests (when approved)
CREATE OR REPLACE FUNCTION public.log_deposit_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'approved' AND (OLD.status IS NULL OR OLD.status != 'approved') THEN
    INSERT INTO public.general_ledger (
      transaction_date, amount, direction, category, description,
      user_id, reference_id, source_table, source_id
    ) VALUES (
      COALESCE(NEW.approved_at, now()),
      NEW.amount,
      'cash_in',
      'deposit',
      'Wallet deposit via ' || COALESCE(NEW.provider, 'mobile money'),
      NEW.user_id,
      NEW.transaction_id,
      'deposit_requests',
      NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_deposit_to_ledger
AFTER INSERT OR UPDATE ON public.deposit_requests
FOR EACH ROW
EXECUTE FUNCTION public.log_deposit_to_ledger();
