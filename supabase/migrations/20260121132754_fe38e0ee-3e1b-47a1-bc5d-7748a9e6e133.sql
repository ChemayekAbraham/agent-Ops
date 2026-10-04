-- Create table to track recurring ROI payments to supporters
CREATE TABLE public.supporter_roi_payments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  payment_proof_id UUID NOT NULL REFERENCES public.landlord_payment_proofs(id) ON DELETE CASCADE,
  supporter_id UUID NOT NULL REFERENCES public.profiles(id),
  rent_amount NUMERIC NOT NULL,
  roi_amount NUMERIC NOT NULL,
  payment_number INTEGER NOT NULL DEFAULT 1,
  due_date TIMESTAMP WITH TIME ZONE NOT NULL,
  paid_at TIMESTAMP WITH TIME ZONE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(payment_proof_id, payment_number)
);

-- Enable RLS
ALTER TABLE public.supporter_roi_payments ENABLE ROW LEVEL SECURITY;

-- Supporters can view their own ROI payments
CREATE POLICY "Supporters can view own ROI payments"
ON public.supporter_roi_payments
FOR SELECT
USING (supporter_id = auth.uid());

-- Managers can view all ROI payments
CREATE POLICY "Managers can view all ROI payments"
ON public.supporter_roi_payments
FOR SELECT
USING (has_role(auth.uid(), 'manager'::app_role));

-- System can insert/update (via service role from edge function)
CREATE POLICY "Service role can manage ROI payments"
ON public.supporter_roi_payments
FOR ALL
USING (true)
WITH CHECK (true);

-- Add column to track last ROI payment date on payment proofs
ALTER TABLE public.landlord_payment_proofs
ADD COLUMN IF NOT EXISTS last_roi_payment_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS next_roi_due_date TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS total_roi_paid NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS roi_payments_count INTEGER DEFAULT 0;

-- Create index for efficient querying of due payments
CREATE INDEX idx_supporter_roi_payments_due ON public.supporter_roi_payments(due_date, status) WHERE status = 'pending';
CREATE INDEX idx_landlord_payment_proofs_next_roi ON public.landlord_payment_proofs(next_roi_due_date) WHERE status = 'verified';