-- Create payment_confirmations table for storing payment proofs
CREATE TABLE public.payment_confirmations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  dashboard_type TEXT NOT NULL CHECK (dashboard_type IN ('tenant', 'supporter')),
  payment_partner TEXT NOT NULL CHECK (payment_partner IN ('mtn', 'airtel')),
  amount NUMERIC NOT NULL CHECK (amount > 0),
  transaction_id TEXT NOT NULL,
  screenshot_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_note TEXT,
  processed_by UUID,
  processed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.payment_confirmations ENABLE ROW LEVEL SECURITY;

-- Users can view their own payment confirmations
CREATE POLICY "Users can view their own payment confirmations"
ON public.payment_confirmations
FOR SELECT
USING (auth.uid() = user_id);

-- Users can create their own payment confirmations
CREATE POLICY "Users can create their own payment confirmations"
ON public.payment_confirmations
FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Managers can view all payment confirmations
CREATE POLICY "Managers can view all payment confirmations"
ON public.payment_confirmations
FOR SELECT
USING (public.has_role(auth.uid(), 'manager'));

-- Managers can update payment confirmations
CREATE POLICY "Managers can update payment confirmations"
ON public.payment_confirmations
FOR UPDATE
USING (public.has_role(auth.uid(), 'manager'));

-- Create trigger for updated_at
CREATE TRIGGER update_payment_confirmations_updated_at
BEFORE UPDATE ON public.payment_confirmations
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create index for faster queries
CREATE INDEX idx_payment_confirmations_user_id ON public.payment_confirmations(user_id);
CREATE INDEX idx_payment_confirmations_status ON public.payment_confirmations(status);

-- Enable realtime for payment confirmations
ALTER PUBLICATION supabase_realtime ADD TABLE public.payment_confirmations;