
CREATE TABLE public.angel_pool_investments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id UUID NOT NULL REFERENCES public.profiles(id),
  amount BIGINT NOT NULL,
  shares INTEGER NOT NULL,
  pool_ownership_percent NUMERIC(10,6) NOT NULL,
  company_ownership_percent NUMERIC(10,6) NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',
  transaction_group_id UUID,
  reference_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.angel_pool_investments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own angel investments"
  ON public.angel_pool_investments FOR SELECT TO authenticated
  USING (investor_id = auth.uid());

CREATE POLICY "Staff view all angel investments"
  ON public.angel_pool_investments FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'manager') OR
    public.has_role(auth.uid(), 'cfo') OR
    public.has_role(auth.uid(), 'coo')
  );

CREATE POLICY "System insert angel investments"
  ON public.angel_pool_investments FOR INSERT TO authenticated
  WITH CHECK (investor_id = auth.uid());
