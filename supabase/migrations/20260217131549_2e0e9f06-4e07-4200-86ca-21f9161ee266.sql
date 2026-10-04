
-- Credit request verification details table
CREATE TABLE public.credit_request_details (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID REFERENCES public.user_loans(id) ON DELETE CASCADE,
  borrower_id UUID NOT NULL,
  
  -- Borrower identity
  borrower_phone TEXT NOT NULL,
  borrower_mm_name TEXT NOT NULL,
  
  -- Landlord details
  landlord_name TEXT NOT NULL,
  landlord_phone TEXT NOT NULL,
  landlord_on_platform BOOLEAN DEFAULT false,
  landlord_id UUID,
  
  -- Utility meter verification
  electricity_meter_number TEXT,
  water_meter_number TEXT,
  
  -- Location
  location_latitude DOUBLE PRECISION,
  location_longitude DOUBLE PRECISION,
  location_address TEXT,
  
  -- Repayment preferences
  repayment_frequency TEXT NOT NULL DEFAULT 'daily',
  duration_days INTEGER NOT NULL DEFAULT 30,
  platform_fee_rate NUMERIC NOT NULL DEFAULT 5,
  funder_interest_rate NUMERIC NOT NULL DEFAULT 0,
  platform_fee_amount NUMERIC NOT NULL DEFAULT 0,
  total_with_fees NUMERIC NOT NULL DEFAULT 0,
  
  -- Agent verification
  agent_id UUID,
  agent_verified BOOLEAN DEFAULT false,
  agent_verified_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.credit_request_details ENABLE ROW LEVEL SECURITY;

-- Borrower can view and create their own
CREATE POLICY "Borrowers can view own credit requests"
  ON public.credit_request_details FOR SELECT
  USING (auth.uid() = borrower_id);

CREATE POLICY "Borrowers can create credit requests"
  ON public.credit_request_details FOR INSERT
  WITH CHECK (auth.uid() = borrower_id);

-- Agents can view and update for verification
CREATE POLICY "Agents can view credit requests"
  ON public.credit_request_details FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'agent')
  );

CREATE POLICY "Agents can verify credit requests"
  ON public.credit_request_details FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'agent')
  );

-- Managers can view all
CREATE POLICY "Managers can view all credit requests"
  ON public.credit_request_details FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'manager')
  );

-- Supporters/funders can view all
CREATE POLICY "Supporters can view credit requests"
  ON public.credit_request_details FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'supporter')
  );
