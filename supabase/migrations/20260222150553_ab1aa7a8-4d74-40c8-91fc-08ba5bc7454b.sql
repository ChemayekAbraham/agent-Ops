
-- Table to track 15% monthly supporter rewards on funded rent requests
CREATE TABLE public.supporter_roi_payments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  rent_request_id UUID NOT NULL REFERENCES public.rent_requests(id),
  supporter_id UUID NOT NULL,
  rent_amount NUMERIC NOT NULL,
  roi_amount NUMERIC NOT NULL,
  payment_number INTEGER NOT NULL DEFAULT 1,
  due_date TIMESTAMP WITH TIME ZONE NOT NULL,
  paid_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending'
);

-- Prevent duplicate payments for same rent request and payment period
CREATE UNIQUE INDEX idx_supporter_roi_unique ON public.supporter_roi_payments (rent_request_id, payment_number);

-- Index for efficient querying by supporter
CREATE INDEX idx_supporter_roi_supporter ON public.supporter_roi_payments (supporter_id);
CREATE INDEX idx_supporter_roi_status ON public.supporter_roi_payments (status, due_date);

-- Enable RLS
ALTER TABLE public.supporter_roi_payments ENABLE ROW LEVEL SECURITY;

-- Supporters can view their own ROI payments
CREATE POLICY "Supporters can view own ROI payments"
  ON public.supporter_roi_payments FOR SELECT
  USING (auth.uid() = supporter_id);

-- Managers can view all ROI payments
CREATE POLICY "Managers can view all ROI payments"
  ON public.supporter_roi_payments FOR SELECT
  USING (has_role(auth.uid(), 'manager'::app_role));

-- System can insert ROI payments (edge function uses service role)
CREATE POLICY "System can insert ROI payments"
  ON public.supporter_roi_payments FOR INSERT
  WITH CHECK (true);

-- System can update ROI payments
CREATE POLICY "System can update ROI payments"
  ON public.supporter_roi_payments FOR UPDATE
  USING (true);

-- Add ROI tracking columns to rent_requests for quick lookup
ALTER TABLE public.rent_requests 
  ADD COLUMN IF NOT EXISTS next_roi_due_date TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS total_roi_paid NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS roi_payments_count INTEGER DEFAULT 0;
