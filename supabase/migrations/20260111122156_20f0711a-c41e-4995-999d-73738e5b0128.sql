-- Create table for manager-recorded incoming transactions (from merchant payments)
CREATE TABLE public.manager_recorded_transactions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  recorded_by UUID NOT NULL,
  payment_partner TEXT NOT NULL CHECK (payment_partner IN ('mtn', 'airtel')),
  transaction_id TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  sender_phone TEXT,
  notes TEXT,
  matched BOOLEAN DEFAULT FALSE,
  matched_confirmation_id UUID REFERENCES public.payment_confirmations(id),
  matched_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create unique index on transaction_id + payment_partner for fast lookup
CREATE UNIQUE INDEX idx_manager_transactions_lookup 
ON public.manager_recorded_transactions(LOWER(transaction_id), payment_partner);

-- Enable RLS
ALTER TABLE public.manager_recorded_transactions ENABLE ROW LEVEL SECURITY;

-- Allow managers to insert and view
CREATE POLICY "Managers can insert transactions"
ON public.manager_recorded_transactions
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.user_roles 
    WHERE user_id = auth.uid() AND role = 'manager'
  )
);

CREATE POLICY "Managers can view all transactions"
ON public.manager_recorded_transactions
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles 
    WHERE user_id = auth.uid() AND role = 'manager'
  )
);

CREATE POLICY "Managers can update transactions"
ON public.manager_recorded_transactions
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles 
    WHERE user_id = auth.uid() AND role = 'manager'
  )
);

-- Add index to payment_confirmations for faster matching
CREATE INDEX IF NOT EXISTS idx_payment_confirmations_txid 
ON public.payment_confirmations(LOWER(transaction_id), payment_partner);