ALTER TABLE public.general_ledger
ADD COLUMN IF NOT EXISTS idempotency_key TEXT;