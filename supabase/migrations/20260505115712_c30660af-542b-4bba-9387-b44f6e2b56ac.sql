ALTER TABLE public.angel_pool_investments
  ALTER COLUMN reference_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS angel_pool_investments_reference_id_key
  ON public.angel_pool_investments (reference_id);