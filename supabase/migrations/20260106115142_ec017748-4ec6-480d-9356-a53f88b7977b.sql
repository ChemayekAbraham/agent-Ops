-- Create table to track investment interest payments
CREATE TABLE public.investment_interest_payments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.investment_accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  principal_amount NUMERIC NOT NULL,
  interest_rate NUMERIC NOT NULL DEFAULT 0.15,
  interest_amount NUMERIC NOT NULL,
  payment_month TEXT NOT NULL,
  credited_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(account_id, payment_month)
);

-- Enable Row Level Security
ALTER TABLE public.investment_interest_payments ENABLE ROW LEVEL SECURITY;

-- Users can view their own interest payments
CREATE POLICY "Users can view their own interest payments" 
ON public.investment_interest_payments 
FOR SELECT 
USING (auth.uid() = user_id);

-- Managers can view all interest payments
CREATE POLICY "Managers can view all interest payments" 
ON public.investment_interest_payments 
FOR SELECT 
USING (public.has_role(auth.uid(), 'manager'));