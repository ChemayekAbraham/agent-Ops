CREATE TABLE public.portfolio_maturity_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.investor_portfolios(id) ON DELETE CASCADE,
  maturity_date date NOT NULL,
  recipient_email text,
  source text NOT NULL DEFAULT 'auto',
  outcome text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, maturity_date)
);
GRANT SELECT ON public.portfolio_maturity_notices TO authenticated;
GRANT ALL ON public.portfolio_maturity_notices TO service_role;
ALTER TABLE public.portfolio_maturity_notices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Ops can view maturity notices" ON public.portfolio_maturity_notices FOR SELECT TO authenticated
USING (public.has_role(auth.uid(),'partner_ops') OR public.has_role(auth.uid(),'coo') OR public.has_role(auth.uid(),'manager')
    OR public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'ceo'));