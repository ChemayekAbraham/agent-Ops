
ALTER TABLE public.angel_pool_investments
  ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS payment_method TEXT,
  ADD COLUMN IF NOT EXISTS investment_reference TEXT;
