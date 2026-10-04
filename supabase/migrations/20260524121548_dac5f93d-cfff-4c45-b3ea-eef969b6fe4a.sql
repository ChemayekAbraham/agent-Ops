DO $$
BEGIN
  PERFORM set_config('ledger.bypass_guard', 'true', true);

  ALTER TABLE public.general_ledger DISABLE TRIGGER trg_prevent_ledger_update;

  UPDATE public.general_ledger
  SET wallet_bucket = 'float',
      routing_source = COALESCE(routing_source, 'recipient_type_v2_backfill')
  WHERE ledger_scope = 'wallet'
    AND wallet_bucket IS NULL
    AND recipient_type = 'operational_wallet';

  UPDATE public.general_ledger
  SET wallet_bucket = 'withdrawable',
      routing_source = COALESCE(routing_source, 'recipient_type_v2_backfill')
  WHERE ledger_scope = 'wallet'
    AND wallet_bucket IS NULL
    AND recipient_type = 'user';

  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_update;
END $$;

-- Refresh pivot for affected users
WITH affected AS (
  SELECT DISTINCT user_id
  FROM public.general_ledger
  WHERE ledger_scope = 'wallet'
    AND routing_source = 'recipient_type_v2_backfill'
), recomputed AS (
  SELECT u.user_id,
         GREATEST(0, COALESCE(s.withdrawable, 0)) AS w,
         GREATEST(0, COALESCE(s.float_balance, 0)) AS f,
         GREATEST(0, COALESCE(s.advance_balance, 0)) AS a
  FROM affected u
  LEFT JOIN public.v_user_wallet_strict s ON s.user_id = u.user_id
)
INSERT INTO public.ledger_balance_pivot (user_id, bucket, balance_sum, last_updated_at)
SELECT user_id, b.bucket, b.bal, now()
FROM recomputed
CROSS JOIN LATERAL (VALUES
  ('withdrawable', w),
  ('float', f),
  ('advance', a)
) b(bucket, bal)
ON CONFLICT (user_id, bucket)
DO UPDATE SET balance_sum = EXCLUDED.balance_sum, last_updated_at = now();