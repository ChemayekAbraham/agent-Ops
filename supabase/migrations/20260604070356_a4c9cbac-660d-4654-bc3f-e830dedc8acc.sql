ALTER TABLE public.cash_deposit_verifications
  ALTER COLUMN expires_at SET DEFAULT (now() + '00:10:00'::interval);