
CREATE TABLE public.angel_pool_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  total_pool_ugx bigint NOT NULL DEFAULT 500000000,
  total_shares integer NOT NULL DEFAULT 25000,
  price_per_share integer NOT NULL DEFAULT 20000,
  pool_equity_percent numeric(5,2) NOT NULL DEFAULT 8.00,
  updated_at timestamptz DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id)
);

ALTER TABLE public.angel_pool_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read angel_pool_config"
  ON public.angel_pool_config FOR SELECT TO authenticated USING (true);

CREATE POLICY "CEO update angel_pool_config"
  ON public.angel_pool_config FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'ceo'));

CREATE POLICY "CEO insert angel_pool_config"
  ON public.angel_pool_config FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'ceo'));

INSERT INTO public.angel_pool_config (total_pool_ugx, total_shares, price_per_share, pool_equity_percent)
VALUES (500000000, 25000, 20000, 8.00);
