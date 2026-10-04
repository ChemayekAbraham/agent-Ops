-- ============================================================
-- PART A: Delete duplicate wallet_transactions (keep oldest of each group)
-- ============================================================
ALTER TABLE public.wallet_transactions DISABLE TRIGGER trg_wallet_transfer_to_ledger;

-- Also clean linked pending_wallet_operations queue rows
DELETE FROM public.pending_wallet_operations
WHERE source_table='wallet_transactions'
  AND source_id IN (
    -- WIP2601253293 extras (keep 9ad4acc5)
    'ff0b15bf-a5bb-4d0c-9652-040e4072a9f7',
    '5ca33817-02c7-4db0-b9fd-c9e9f78ba5cd',
    -- WIP2604031412 extras (keep 407240f0)
    '111e31ab-aa3b-43d1-835b-b9ff0063380d',
    -- WIP2503248054 extras (keep 4a6b8a69)
    'dcf599b8-b5f0-43b4-b239-e3a7ea1ee401',
    -- WIP2603092070 extras (keep 9aed9771)
    '348e9687-b035-418c-bfef-9c85e608f715',
    '295f5800-ddd4-42e3-97e4-ec6090c88c8a',
    '9abbe273-4022-4982-9193-7acea3127472',
    '7001b05c-b91f-4e68-837c-d77752b4bea4'
  );

DELETE FROM public.wallet_transactions
WHERE id IN (
  'ff0b15bf-a5bb-4d0c-9652-040e4072a9f7',
  '5ca33817-02c7-4db0-b9fd-c9e9f78ba5cd',
  '111e31ab-aa3b-43d1-835b-b9ff0063380d',
  'dcf599b8-b5f0-43b4-b239-e3a7ea1ee401',
  '348e9687-b035-418c-bfef-9c85e608f715',
  '295f5800-ddd4-42e3-97e4-ec6090c88c8a',
  '9abbe273-4022-4982-9193-7acea3127472',
  '7001b05c-b91f-4e68-837c-d77752b4bea4'
);

ALTER TABLE public.wallet_transactions ENABLE TRIGGER trg_wallet_transfer_to_ledger;

-- ============================================================
-- PART B: Idempotency guard for future top-ups (5-min bucket)
-- ============================================================
CREATE OR REPLACE FUNCTION public.topup_dedup_bucket(ts timestamptz)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT to_timestamp(floor(extract(epoch from ts) / 300) * 300) AT TIME ZONE 'UTC'
$$;

DROP INDEX IF EXISTS public.wallet_transactions_topup_dedup_idx;

CREATE UNIQUE INDEX wallet_transactions_topup_dedup_idx
ON public.wallet_transactions (
  sender_id,
  recipient_id,
  amount,
  description,
  public.topup_dedup_bucket(created_at)
)
WHERE description LIKE 'Portfolio top-up:%';