
-- Migration 1: Add investor-specific columns to supporter_invites
ALTER TABLE public.supporter_invites
  ADD COLUMN IF NOT EXISTS national_id TEXT,
  ADD COLUMN IF NOT EXISTS country TEXT DEFAULT 'Uganda',
  ADD COLUMN IF NOT EXISTS district_city TEXT,
  ADD COLUMN IF NOT EXISTS next_of_kin_name TEXT,
  ADD COLUMN IF NOT EXISTS next_of_kin_relationship TEXT,
  ADD COLUMN IF NOT EXISTS next_of_kin_phone TEXT,
  ADD COLUMN IF NOT EXISTS payment_method TEXT,
  ADD COLUMN IF NOT EXISTS mobile_network TEXT,
  ADD COLUMN IF NOT EXISTS mobile_money_number TEXT,
  ADD COLUMN IF NOT EXISTS bank_name TEXT,
  ADD COLUMN IF NOT EXISTS account_name TEXT,
  ADD COLUMN IF NOT EXISTS account_number TEXT;

-- Migration 2: Create investor_portfolios table
CREATE TABLE public.investor_portfolios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  invite_id UUID REFERENCES public.supporter_invites(id) ON DELETE SET NULL,
  agent_id UUID NOT NULL REFERENCES public.profiles(id),
  portfolio_code TEXT NOT NULL UNIQUE,
  investment_amount NUMERIC NOT NULL,
  duration_months INT NOT NULL,
  roi_percentage NUMERIC NOT NULL DEFAULT 15,
  roi_mode TEXT NOT NULL DEFAULT 'monthly_payout',
  payment_method TEXT,
  mobile_network TEXT,
  mobile_money_number TEXT,
  bank_name TEXT,
  account_name TEXT,
  account_number TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  portfolio_pin TEXT NOT NULL,
  activation_token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  maturity_date DATE,
  next_roi_date DATE,
  total_roi_earned NUMERIC NOT NULL DEFAULT 0
);

-- RLS
ALTER TABLE public.investor_portfolios ENABLE ROW LEVEL SECURITY;

-- Agents can insert and select their own portfolios
CREATE POLICY "Agents can insert own portfolios"
  ON public.investor_portfolios FOR INSERT TO authenticated
  WITH CHECK (agent_id = auth.uid());

CREATE POLICY "Agents can select own portfolios"
  ON public.investor_portfolios FOR SELECT TO authenticated
  USING (agent_id = auth.uid());

-- Investors can select their own portfolios
CREATE POLICY "Investors can select own portfolios"
  ON public.investor_portfolios FOR SELECT TO authenticated
  USING (investor_id = auth.uid());

-- Managers can select all portfolios
CREATE POLICY "Managers can select all portfolios"
  ON public.investor_portfolios FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'manager'));

-- Anon can select by activation_token (for shareable links)
CREATE POLICY "Anon can select by activation_token"
  ON public.investor_portfolios FOR SELECT TO anon
  USING (true);

-- Generate portfolio code function
CREATE OR REPLACE FUNCTION public.generate_portfolio_code()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  code TEXT;
  exists_already BOOLEAN;
BEGIN
  LOOP
    code := 'WPF-' || LPAD(floor(random() * 10000)::int::text, 4, '0');
    SELECT EXISTS(SELECT 1 FROM public.investor_portfolios WHERE portfolio_code = code) INTO exists_already;
    EXIT WHEN NOT exists_already;
  END LOOP;
  RETURN code;
END;
$$;
