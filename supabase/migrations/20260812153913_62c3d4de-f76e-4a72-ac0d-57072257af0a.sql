-- Deduplicate before enforcing uniqueness (keep largest, then newest).
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
           PARTITION BY withdrawal_id, kind
           ORDER BY shortfall_amount DESC, created_at DESC, id DESC) rn
  FROM public.merchant_out_of_pocket_advances
)
DELETE FROM public.merchant_out_of_pocket_advances o
USING ranked r
WHERE o.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS merchant_oop_withdrawal_kind_uniq
  ON public.merchant_out_of_pocket_advances (withdrawal_id, kind);

SELECT public.reconcile_merchant_payout_funding(200000, 3000) AS batch_a;
SELECT public.reconcile_merchant_payout_funding(200000, 6000) AS batch_b;

DROP TABLE IF EXISTS public.tmp_phase6_diag;