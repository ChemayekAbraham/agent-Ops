-- Ensure the parser columns exist
ALTER TABLE public.gmail_transactions
  ADD COLUMN IF NOT EXISTS direction text,
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS counterparty text,
  ADD COLUMN IF NOT EXISTS fee numeric,
  ADD COLUMN IF NOT EXISTS balance numeric,
  ADD COLUMN IF NOT EXISTS dedup_hash text;

-- 1) Null out junk transaction_ids (too short, or matching common stop-words)
UPDATE public.gmail_transactions
SET transaction_id = NULL
WHERE transaction_id IS NOT NULL
  AND (
    char_length(transaction_id) < 6
    OR lower(transaction_id) IN ('from','to','by','ref','txn','trans','receipt','reference','confirmation','txnid','transid','of','the','your','this','that','with','sent','paid','received')
    OR transaction_id !~ '[0-9]'
  );

-- 2) Collapse remaining duplicates by transaction_id, keeping the earliest row
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY lower(transaction_id) ORDER BY created_at, id) AS rn
  FROM public.gmail_transactions
  WHERE transaction_id IS NOT NULL
)
DELETE FROM public.gmail_transactions g
USING ranked r
WHERE g.id = r.id AND r.rn > 1;

-- 3) Backfill dedup_hash for survivors
UPDATE public.gmail_transactions
SET dedup_hash = encode(
  digest(
    coalesce(lower(transaction_id), '') || '|' ||
    coalesce(from_email, '') || '|' ||
    coalesce(amount::text, '') || '|' ||
    coalesce(to_char(internal_date, 'YYYY-MM-DD HH24:MI'), '') || '|' ||
    coalesce(counterparty, ''),
    'sha256'
  ),
  'hex'
)
WHERE dedup_hash IS NULL
  AND (transaction_id IS NOT NULL OR amount IS NOT NULL);

-- 4) Collapse duplicates by dedup_hash too
WITH ranked2 AS (
  SELECT id, row_number() OVER (PARTITION BY dedup_hash ORDER BY created_at, id) AS rn
  FROM public.gmail_transactions
  WHERE dedup_hash IS NOT NULL
)
DELETE FROM public.gmail_transactions g
USING ranked2 r
WHERE g.id = r.id AND r.rn > 1;

-- 5) Unique indexes
CREATE UNIQUE INDEX IF NOT EXISTS uq_gmail_tx_transaction_id
  ON public.gmail_transactions (lower(transaction_id))
  WHERE transaction_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_gmail_tx_dedup_hash
  ON public.gmail_transactions (dedup_hash)
  WHERE dedup_hash IS NOT NULL;