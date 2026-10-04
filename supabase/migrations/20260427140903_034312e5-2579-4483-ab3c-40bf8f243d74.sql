DROP INDEX IF EXISTS public.wallet_transactions_topup_dedup_idx;

CREATE UNIQUE INDEX wallet_transactions_topup_dedup_idx
ON public.wallet_transactions (
  sender_id,
  recipient_id,
  amount,
  description,
  public.topup_dedup_bucket(created_at)
)
WHERE description LIKE 'Portfolio top-up:%'
   OR description LIKE 'COO Portfolio transfer:%';