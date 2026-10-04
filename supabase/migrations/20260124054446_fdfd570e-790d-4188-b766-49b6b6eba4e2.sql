-- Add columns for self-service deposits with transaction verification
ALTER TABLE public.deposit_requests 
  ALTER COLUMN agent_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS transaction_id text,
  ADD COLUMN IF NOT EXISTS transaction_date timestamp with time zone,
  ADD COLUMN IF NOT EXISTS notes text;

-- Add unique constraint on transaction_id to prevent duplicates
CREATE UNIQUE INDEX IF NOT EXISTS deposit_requests_transaction_id_unique 
ON public.deposit_requests(transaction_id) 
WHERE transaction_id IS NOT NULL;

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS deposit_requests_transaction_id_idx 
ON public.deposit_requests(transaction_id) 
WHERE transaction_id IS NOT NULL;