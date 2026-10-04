-- Create loan_products table for agents to create loan offerings
CREATE TABLE public.loan_products (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  min_amount numeric NOT NULL,
  max_amount numeric NOT NULL,
  interest_rate numeric NOT NULL DEFAULT 10,
  min_duration_days integer NOT NULL DEFAULT 7,
  max_duration_days integer NOT NULL DEFAULT 30,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Create loan_applications table for users to apply
CREATE TABLE public.loan_applications (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  loan_product_id uuid NOT NULL REFERENCES public.loan_products(id) ON DELETE CASCADE,
  applicant_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  amount numeric NOT NULL,
  interest_rate numeric NOT NULL,
  duration_days integer NOT NULL,
  total_repayment numeric NOT NULL,
  purpose text,
  status text NOT NULL DEFAULT 'pending',
  approved_by uuid,
  approved_at timestamp with time zone,
  rejected_reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.loan_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loan_applications ENABLE ROW LEVEL SECURITY;

-- RLS policies for loan_products
CREATE POLICY "Anyone can view active loan products"
  ON public.loan_products FOR SELECT
  USING (active = true);

CREATE POLICY "Agents can manage own loan products"
  ON public.loan_products FOR ALL
  USING (has_role(auth.uid(), 'agent'::app_role) AND agent_id = auth.uid())
  WITH CHECK (has_role(auth.uid(), 'agent'::app_role) AND agent_id = auth.uid());

CREATE POLICY "Managers can view all loan products"
  ON public.loan_products FOR SELECT
  USING (has_role(auth.uid(), 'manager'::app_role));

-- RLS policies for loan_applications
CREATE POLICY "Users can apply for loans"
  ON public.loan_applications FOR INSERT
  WITH CHECK (auth.uid() = applicant_id);

CREATE POLICY "Users can view own applications"
  ON public.loan_applications FOR SELECT
  USING (auth.uid() = applicant_id);

CREATE POLICY "Agents can view applications for their products"
  ON public.loan_applications FOR SELECT
  USING (auth.uid() = agent_id);

CREATE POLICY "Managers can view all applications"
  ON public.loan_applications FOR SELECT
  USING (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "Managers can update applications"
  ON public.loan_applications FOR UPDATE
  USING (has_role(auth.uid(), 'manager'::app_role));

-- Trigger for updated_at
CREATE TRIGGER update_loan_products_updated_at
  BEFORE UPDATE ON public.loan_products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_loan_applications_updated_at
  BEFORE UPDATE ON public.loan_applications
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();