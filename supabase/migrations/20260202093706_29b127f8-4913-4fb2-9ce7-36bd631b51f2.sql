-- Create investment_transactions table to track all investment account activity
CREATE TABLE IF NOT EXISTS public.investment_transactions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.investment_accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('investment', 'top_up', 'roi_payout', 'withdrawal', 'adjustment')),
  amount NUMERIC NOT NULL,
  balance_before NUMERIC NOT NULL,
  balance_after NUMERIC NOT NULL,
  description TEXT,
  performed_by UUID,
  transaction_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.investment_transactions ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own transactions
CREATE POLICY "Users can view their own investment transactions"
ON public.investment_transactions
FOR SELECT
USING (user_id = auth.uid());

-- Policy: Managers can view all transactions
CREATE POLICY "Managers can view all investment transactions"
ON public.investment_transactions
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'manager' AND enabled = true
  )
);

-- Policy: Managers can insert transactions
CREATE POLICY "Managers can insert investment transactions"
ON public.investment_transactions
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'manager' AND enabled = true
  )
);

-- Create index for faster queries
CREATE INDEX idx_investment_transactions_account_id ON public.investment_transactions(account_id);
CREATE INDEX idx_investment_transactions_user_id ON public.investment_transactions(user_id);
CREATE INDEX idx_investment_transactions_date ON public.investment_transactions(transaction_date DESC);

-- Enable realtime for investment transactions
ALTER PUBLICATION supabase_realtime ADD TABLE public.investment_transactions;