-- Vendors table (shops, supermarkets registered by managers)
CREATE TABLE public.vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  location text,
  phone text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true
);

ALTER TABLE public.vendors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers can manage vendors"
  ON public.vendors FOR ALL
  USING (has_role(auth.uid(), 'manager'::app_role))
  WITH CHECK (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "Anyone can view active vendors"
  ON public.vendors FOR SELECT
  USING (active = true);

-- Receipt numbers created by managers and assigned to vendors
CREATE TABLE public.receipt_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_code text UNIQUE NOT NULL,
  vendor_id uuid REFERENCES public.vendors(id) ON DELETE CASCADE NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  vendor_amount numeric,
  vendor_marked_at timestamptz,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'used', 'expired'))
);

ALTER TABLE public.receipt_numbers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers can manage receipt numbers"
  ON public.receipt_numbers FOR ALL
  USING (has_role(auth.uid(), 'manager'::app_role))
  WITH CHECK (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "Users can view receipt numbers"
  ON public.receipt_numbers FOR SELECT
  USING (true);

-- User submitted receipts
CREATE TABLE public.user_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  receipt_number_id uuid REFERENCES public.receipt_numbers(id) NOT NULL,
  items_description text NOT NULL,
  claimed_amount numeric NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  rejection_reason text,
  loan_contribution numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can submit receipts"
  ON public.user_receipts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view own receipts"
  ON public.user_receipts FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Managers can view all receipts"
  ON public.user_receipts FOR SELECT
  USING (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "System can update receipts"
  ON public.user_receipts FOR UPDATE
  USING (true);

-- User loan limits (20% of verified receipt amounts)
CREATE TABLE public.loan_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid UNIQUE NOT NULL,
  total_verified_amount numeric NOT NULL DEFAULT 0,
  available_limit numeric NOT NULL DEFAULT 0,
  used_limit numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.loan_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own loan limit"
  ON public.loan_limits FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Managers can view all loan limits"
  ON public.loan_limits FOR SELECT
  USING (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "Agents can view loan limits"
  ON public.loan_limits FOR SELECT
  USING (has_role(auth.uid(), 'agent'::app_role));

CREATE POLICY "System can manage loan limits"
  ON public.loan_limits FOR ALL
  USING (true)
  WITH CHECK (true);

-- Loans created by lending partners (agents)
CREATE TABLE public.user_loans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  borrower_id uuid NOT NULL,
  lender_id uuid NOT NULL,
  amount numeric NOT NULL,
  interest_rate numeric NOT NULL DEFAULT 10,
  total_repayment numeric NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'repaid', 'defaulted')),
  due_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  repaid_at timestamptz
);

ALTER TABLE public.user_loans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Borrowers can view own loans"
  ON public.user_loans FOR SELECT
  USING (auth.uid() = borrower_id);

CREATE POLICY "Agents can view loans they created"
  ON public.user_loans FOR SELECT
  USING (auth.uid() = lender_id);

CREATE POLICY "Agents can create loans"
  ON public.user_loans FOR INSERT
  WITH CHECK (has_role(auth.uid(), 'agent'::app_role) AND auth.uid() = lender_id);

CREATE POLICY "Agents can update own loans"
  ON public.user_loans FOR UPDATE
  USING (auth.uid() = lender_id);

CREATE POLICY "Managers can view all loans"
  ON public.user_loans FOR SELECT
  USING (has_role(auth.uid(), 'manager'::app_role));

-- Function to auto-verify receipts and update loan limits
CREATE OR REPLACE FUNCTION public.verify_user_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  vendor_marked_amount numeric;
  contribution numeric;
BEGIN
  -- Get the vendor marked amount for this receipt number
  SELECT rn.vendor_amount INTO vendor_marked_amount
  FROM public.receipt_numbers rn
  WHERE rn.id = NEW.receipt_number_id;
  
  -- If vendor has marked the amount and it matches (within 10% tolerance)
  IF vendor_marked_amount IS NOT NULL THEN
    IF ABS(vendor_marked_amount - NEW.claimed_amount) <= (vendor_marked_amount * 0.1) THEN
      -- Verify the receipt
      NEW.verified := true;
      NEW.verified_at := now();
      NEW.loan_contribution := vendor_marked_amount * 0.20; -- 20% contribution
      
      -- Update receipt number status
      UPDATE public.receipt_numbers
      SET status = 'used'
      WHERE id = NEW.receipt_number_id;
      
      -- Update or insert loan limit
      INSERT INTO public.loan_limits (user_id, total_verified_amount, available_limit)
      VALUES (NEW.user_id, vendor_marked_amount, vendor_marked_amount * 0.20)
      ON CONFLICT (user_id) DO UPDATE
      SET total_verified_amount = loan_limits.total_verified_amount + vendor_marked_amount,
          available_limit = loan_limits.available_limit + (vendor_marked_amount * 0.20),
          updated_at = now();
    ELSE
      -- Reject due to amount mismatch
      NEW.verified := false;
      NEW.rejection_reason := 'Amount mismatch: vendor recorded ' || vendor_marked_amount || ' but you claimed ' || NEW.claimed_amount;
    END IF;
  ELSE
    -- Reject because vendor hasn't marked this receipt yet
    NEW.verified := false;
    NEW.rejection_reason := 'Receipt not yet verified by vendor';
  END IF;
  
  RETURN NEW;
END;
$$;

-- Trigger for auto-verification
CREATE TRIGGER verify_receipt_on_insert
  BEFORE INSERT ON public.user_receipts
  FOR EACH ROW
  EXECUTE FUNCTION public.verify_user_receipt();