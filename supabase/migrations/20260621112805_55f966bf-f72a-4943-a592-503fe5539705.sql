-- 1. Lending agent loan offers (any user can publish, any user can browse)
CREATE TABLE public.lending_agent_offers (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  lender_agent_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lender_display_name text,
  lender_ai_id text,
  title text NOT NULL,
  description text,
  min_amount_ugx numeric NOT NULL DEFAULT 0,
  max_amount_ugx numeric NOT NULL DEFAULT 0,
  interest_rate_pct numeric NOT NULL DEFAULT 0,
  min_duration_days integer NOT NULL DEFAULT 1,
  max_duration_days integer NOT NULL DEFAULT 30,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lending_agent_offers TO authenticated;
GRANT ALL ON public.lending_agent_offers TO service_role;

ALTER TABLE public.lending_agent_offers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can browse active offers or own offers"
  ON public.lending_agent_offers FOR SELECT TO authenticated
  USING (active = true OR lender_agent_id = auth.uid());

CREATE POLICY "Users manage their own offers"
  ON public.lending_agent_offers FOR INSERT TO authenticated
  WITH CHECK (lender_agent_id = auth.uid());

CREATE POLICY "Users update their own offers"
  ON public.lending_agent_offers FOR UPDATE TO authenticated
  USING (lender_agent_id = auth.uid()) WITH CHECK (lender_agent_id = auth.uid());

CREATE POLICY "Users delete their own offers"
  ON public.lending_agent_offers FOR DELETE TO authenticated
  USING (lender_agent_id = auth.uid());

-- 2. Loan requests from any user to a lending agent
CREATE TABLE public.lending_loan_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  borrower_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lender_agent_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  offer_id uuid REFERENCES public.lending_agent_offers(id) ON DELETE SET NULL,
  borrower_ai_id text,
  borrower_display_name text,
  borrower_phone text,
  requested_amount_ugx numeric NOT NULL,
  requested_duration_days integer,
  interest_rate_pct numeric,
  purpose text,
  status text NOT NULL DEFAULT 'pending',
  decided_at timestamptz,
  loan_id uuid REFERENCES public.lending_agent_loans(id) ON DELETE SET NULL,
  decline_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lending_loan_requests TO authenticated;
GRANT ALL ON public.lending_loan_requests TO service_role;

ALTER TABLE public.lending_loan_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Borrower or lender can view request"
  ON public.lending_loan_requests FOR SELECT TO authenticated
  USING (borrower_user_id = auth.uid() OR lender_agent_id = auth.uid());

CREATE POLICY "Borrower creates own request"
  ON public.lending_loan_requests FOR INSERT TO authenticated
  WITH CHECK (borrower_user_id = auth.uid());

CREATE POLICY "Borrower or lender can update request"
  ON public.lending_loan_requests FOR UPDATE TO authenticated
  USING (borrower_user_id = auth.uid() OR lender_agent_id = auth.uid())
  WITH CHECK (borrower_user_id = auth.uid() OR lender_agent_id = auth.uid());

-- update triggers
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_lending_agent_offers_updated_at
  BEFORE UPDATE ON public.lending_agent_offers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_lending_loan_requests_updated_at
  BEFORE UPDATE ON public.lending_loan_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_lending_offers_active ON public.lending_agent_offers(active, created_at DESC);
CREATE INDEX idx_lending_requests_lender ON public.lending_loan_requests(lender_agent_id, status, created_at DESC);
CREATE INDEX idx_lending_requests_borrower ON public.lending_loan_requests(borrower_user_id, created_at DESC);