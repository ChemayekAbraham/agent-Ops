-- Create late fee configuration table
CREATE TABLE public.late_fee_configurations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  grace_period_days INTEGER NOT NULL DEFAULT 0,
  penalty_type TEXT NOT NULL DEFAULT 'percentage', -- 'percentage' or 'fixed'
  penalty_value NUMERIC NOT NULL DEFAULT 5, -- 5% or fixed amount
  max_penalty_percentage NUMERIC DEFAULT 50, -- Cap at 50% of loan amount
  apply_daily BOOLEAN NOT NULL DEFAULT false, -- Apply penalty daily or once
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create late fees tracking table
CREATE TABLE public.late_fees (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  loan_id UUID NOT NULL REFERENCES public.user_loans(id) ON DELETE CASCADE,
  borrower_id UUID NOT NULL,
  fee_amount NUMERIC NOT NULL,
  days_overdue INTEGER NOT NULL,
  configuration_id UUID REFERENCES public.late_fee_configurations(id),
  applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  paid BOOLEAN NOT NULL DEFAULT false,
  paid_at TIMESTAMP WITH TIME ZONE
);

-- Enable RLS
ALTER TABLE public.late_fee_configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.late_fees ENABLE ROW LEVEL SECURITY;

-- Policies for late_fee_configurations
CREATE POLICY "Managers can manage late fee configurations"
  ON public.late_fee_configurations
  FOR ALL
  USING (has_role(auth.uid(), 'manager'::app_role))
  WITH CHECK (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "Anyone can view active configurations"
  ON public.late_fee_configurations
  FOR SELECT
  USING (active = true);

-- Policies for late_fees
CREATE POLICY "Borrowers can view own late fees"
  ON public.late_fees
  FOR SELECT
  USING (auth.uid() = borrower_id);

CREATE POLICY "Lenders can view late fees on their loans"
  ON public.late_fees
  FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.user_loans
    WHERE user_loans.id = late_fees.loan_id
    AND user_loans.lender_id = auth.uid()
  ));

CREATE POLICY "Managers can view all late fees"
  ON public.late_fees
  FOR SELECT
  USING (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "System can insert late fees"
  ON public.late_fees
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY "System can update late fees"
  ON public.late_fees
  FOR UPDATE
  USING (true);

-- Insert default late fee configuration
INSERT INTO public.late_fee_configurations (name, grace_period_days, penalty_type, penalty_value, max_penalty_percentage, apply_daily)
VALUES ('Default Late Fee', 1, 'percentage', 2, 30, true);

-- Create trigger for updated_at
CREATE TRIGGER update_late_fee_configurations_updated_at
  BEFORE UPDATE ON public.late_fee_configurations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();