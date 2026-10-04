-- Step 6: archive current pivot
CREATE TABLE public.ledger_balance_pivot_2026_08_01_backup AS
SELECT * FROM public.ledger_balance_pivot;

GRANT ALL ON public.ledger_balance_pivot_2026_08_01_backup TO service_role;
ALTER TABLE public.ledger_balance_pivot_2026_08_01_backup ENABLE ROW LEVEL SECURITY;
CREATE POLICY "backup pivot service only"
  ON public.ledger_balance_pivot_2026_08_01_backup
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ledger_balance_pivot_2026_08_01_backup IS
  'Pre-swap snapshot of ledger_balance_pivot taken 2026-08-01 before the strict-view rebuild. Retain at least 7 days for rollback.';

-- Step 7: atomic content swap (same table => dependent views, policies, indexes preserved)
DO $$
DECLARE
  v_canary uuid := 'cb798acb-68bc-4b4e-a414-a3d374e030b6';
  v_canary_before numeric;
  v_canary_after  numeric;
  v_cand_rows bigint;
  v_new_rows  bigint;
  v_cand_sum  numeric;
  v_new_sum   numeric;
  v_bucket_mismatch bigint;
BEGIN
  SELECT COALESCE(SUM(balance_sum),0) INTO v_canary_before
  FROM public.ledger_balance_pivot WHERE user_id = v_canary;

  SELECT COUNT(*), COALESCE(SUM(balance_sum),0) INTO v_cand_rows, v_cand_sum
  FROM public.ledger_balance_pivot_candidate;

  IF v_cand_rows = 0 THEN
    RAISE EXCEPTION 'Candidate pivot is empty - aborting swap';
  END IF;

  DELETE FROM public.ledger_balance_pivot;

  INSERT INTO public.ledger_balance_pivot (user_id, bucket, balance_sum, last_updated_at)
  SELECT user_id, bucket, balance_sum, last_updated_at
  FROM public.ledger_balance_pivot_candidate;

  SELECT COUNT(*), COALESCE(SUM(balance_sum),0) INTO v_new_rows, v_new_sum
  FROM public.ledger_balance_pivot;

  IF v_new_rows <> v_cand_rows OR v_new_sum <> v_cand_sum THEN
    RAISE EXCEPTION 'Invariant failed: rows %/% sums %/%', v_new_rows, v_cand_rows, v_new_sum, v_cand_sum;
  END IF;

  SELECT COUNT(*) INTO v_bucket_mismatch
  FROM (
    SELECT bucket, SUM(balance_sum) s FROM public.ledger_balance_pivot GROUP BY bucket
  ) a
  FULL JOIN (
    SELECT bucket, SUM(balance_sum) s FROM public.ledger_balance_pivot_candidate GROUP BY bucket
  ) b USING (bucket)
  WHERE a.s IS DISTINCT FROM b.s;

  IF v_bucket_mismatch > 0 THEN
    RAISE EXCEPTION 'Per-bucket invariant failed on % buckets', v_bucket_mismatch;
  END IF;

  SELECT COALESCE(SUM(balance_sum),0) INTO v_canary_after
  FROM public.ledger_balance_pivot WHERE user_id = v_canary;

  RAISE NOTICE 'Pivot swap ok: % rows, canary before % after %',
    v_new_rows, v_canary_before, v_canary_after;
END $$;