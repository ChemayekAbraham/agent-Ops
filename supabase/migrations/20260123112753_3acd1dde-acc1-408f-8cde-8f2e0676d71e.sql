-- Add mobile money fields to profiles table for agents
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS mobile_money_number TEXT,
ADD COLUMN IF NOT EXISTS mobile_money_provider TEXT CHECK (mobile_money_provider IN ('MTN', 'Airtel'));

-- Create agent commission payouts table to track withdrawals
CREATE TABLE public.agent_commission_payouts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  mobile_money_number TEXT NOT NULL,
  mobile_money_provider TEXT NOT NULL CHECK (mobile_money_provider IN ('MTN', 'Airtel')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  transaction_id TEXT,
  rejection_reason TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  processed_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.agent_commission_payouts ENABLE ROW LEVEL SECURITY;

-- Agents can view their own payouts
CREATE POLICY "Agents can view their own payouts"
ON public.agent_commission_payouts FOR SELECT
USING (auth.uid() = agent_id);

-- Agents can request payouts
CREATE POLICY "Agents can create payout requests"
ON public.agent_commission_payouts FOR INSERT
WITH CHECK (auth.uid() = agent_id AND status = 'pending');

-- Managers can view all payouts
CREATE POLICY "Managers can view all payouts"
ON public.agent_commission_payouts FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'manager'
  )
);

-- Managers can update payouts (approve/reject)
CREATE POLICY "Managers can update payouts"
ON public.agent_commission_payouts FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'manager'
  )
);

-- Enable realtime for payout updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_commission_payouts;

-- Create index for faster lookups
CREATE INDEX idx_agent_commission_payouts_agent_id ON public.agent_commission_payouts(agent_id);
CREATE INDEX idx_agent_commission_payouts_status ON public.agent_commission_payouts(status);