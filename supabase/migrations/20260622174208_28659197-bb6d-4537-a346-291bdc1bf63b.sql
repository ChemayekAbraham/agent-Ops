CREATE TABLE public.portfolio_action_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  portfolio_id uuid NOT NULL REFERENCES public.investor_portfolios(id) ON DELETE CASCADE,
  portfolio_code text,
  portfolio_name text,
  portfolio_value numeric NOT NULL DEFAULT 0,
  maturity_date date,
  partner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  partner_name text,
  partner_email text,
  request_type text NOT NULL CHECK (request_type IN ('RENEWAL_REQUEST', 'REDEMPTION_REQUEST')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'cancelled')),
  message text,
  currency text NOT NULL DEFAULT 'UGX',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.portfolio_action_requests TO authenticated;
GRANT ALL ON public.portfolio_action_requests TO service_role;

ALTER TABLE public.portfolio_action_requests ENABLE ROW LEVEL SECURITY;

-- Partners can view their own requests (history tracking)
CREATE POLICY "Partners view own portfolio requests"
ON public.portfolio_action_requests
FOR SELECT
TO authenticated
USING (auth.uid() = partner_id);

-- Partners can create their own requests
CREATE POLICY "Partners create own portfolio requests"
ON public.portfolio_action_requests
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = partner_id);

-- Welile operations (manager, coo, super_admin, cto) can view all
CREATE POLICY "Ops view all portfolio requests"
ON public.portfolio_action_requests
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'cto')
);

-- Welile operations can update (process) requests
CREATE POLICY "Ops update portfolio requests"
ON public.portfolio_action_requests
FOR UPDATE
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'cto')
);

-- Prevent duplicate pending requests of the same type per portfolio
CREATE UNIQUE INDEX idx_portfolio_action_requests_no_dupe_pending
ON public.portfolio_action_requests (portfolio_id, request_type)
WHERE status = 'pending';

CREATE INDEX idx_portfolio_action_requests_partner ON public.portfolio_action_requests (partner_id, created_at DESC);

CREATE TRIGGER update_portfolio_action_requests_updated_at
BEFORE UPDATE ON public.portfolio_action_requests
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();