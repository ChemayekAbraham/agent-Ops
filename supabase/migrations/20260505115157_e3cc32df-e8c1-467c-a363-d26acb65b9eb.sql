ALTER TABLE public.angel_pool_investments ADD COLUMN IF NOT EXISTS funded_by text NOT NULL DEFAULT 'investor';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='angel_pool_investments_funded_by_check') THEN
    ALTER TABLE public.angel_pool_investments ADD CONSTRAINT angel_pool_investments_funded_by_check CHECK (funded_by IN ('investor','agent'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_angel_pool_investments_funded_by ON public.angel_pool_investments(funded_by);