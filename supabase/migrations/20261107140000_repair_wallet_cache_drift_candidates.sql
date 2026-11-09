-- =============================================================================
-- Migration: 20261107140000_repair_wallet_cache_drift_candidates.sql
--
-- repair_wallet_cache_drift (cron 507, SELECT repair_wallet_cache_drift(1000)
-- at minutes 5,20,35,50) still builds strict balances for every
-- wallets_physical row (~98k) and only then applies LIMIT p_limit. That strict
-- pass is ~3.4s on its own. This keeps the repair loop and only changes who
-- is passed to public._wallet_strict_for_users_impl.
--
-- Each run's candidates are:
--   (a) wallets_physical users with general_ledger.created_at, or
--       wallet_balances_projection.updated_at, or wallets_physical.updated_at,
--       inside the lookback (24 hours, longer if the state row says so).
--       24 hours covers the 15-minute schedule even when several runs are missed.
--   (b) one hash slice of the remaining wallets. The slice index is
--       wallet_cache_drift_scan_state.next_bucket, advanced by 1 after the
--       candidate comparison. A missed cron run delays the cursor; it does not
--       skip a slice. bucket_count 72 at a 15-minute schedule is a full
--       rotation in 18 hours, so a day still finishes a rotation when up to
--       24 of the 96 daily slots are missed.
--
-- Slice membership (stable for a given bucket_count):
--   mod(mod(hashtextextended(user_id::text, 0), bucket_count)
--       + bucket_count, bucket_count) = next_bucket
-- Every wallets_physical user is in exactly one slice, so the union of (a)
-- and one full rotation is every wallet the old full scan could repair.
-- Silent drift (no ledger row and no cache touch) waits for that user's slice,
-- at most one rotation. Do not change bucket_count without setting
-- next_bucket back to 0 in the same update; the in-progress rotation restarts.
--
-- The cursor is one row. No index is added on wallets_physical,
-- wallet_balances_projection, or general_ledger. The activity read uses
-- idx_general_ledger_created_at; the wallet filters and the hash slice seq-scan
-- ~98k and ~59k rows (~8–22ms, shared hits only). An expression index on the
-- hash would be a second copy of those keys and would need CREATE INDEX
-- CONCURRENTLY, which cannot run inside this migration's transaction.
--
-- Unchanged: the abs >= 1 predicate, repair_wallet_cache_for_user, the 80s
-- budget, LIMIT p_limit, the existing jsonb keys, SECURITY DEFINER,
-- search_path, work_mem, owner and EXECUTE grants. CREATE OR REPLACE keeps
-- the grants. The schedule and the 1000 argument are not changed.
--
-- Live body this rewrite is based on (pg_get_functiondef / prosrc md5,
-- 2026-11-06, project byrzshwlentqvktcksem): a28fc1c45120bf59b166aa625c824bd0.
-- =============================================================================

SET lock_timeout = '5s';

DO $pre$
DECLARE
  v_md5 text;
BEGIN
  IF to_regprocedure('public.repair_wallet_cache_drift(integer)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: public.repair_wallet_cache_drift(integer) does not exist';
  END IF;
  SELECT md5(prosrc) INTO v_md5
  FROM pg_proc
  WHERE oid = 'public.repair_wallet_cache_drift(integer)'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'a28fc1c45120bf59b166aa625c824bd0' THEN
    RAISE EXCEPTION 'precondition failed: repair_wallet_cache_drift prosrc md5 is %, expected a28fc1c45120bf59b166aa625c824bd0', v_md5;
  END IF;
END
$pre$;

CREATE TABLE public.wallet_cache_drift_scan_state (
  id smallint PRIMARY KEY,
  next_bucket integer NOT NULL,
  bucket_count integer NOT NULL,
  lookback interval NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_cache_drift_scan_state_singleton CHECK (id = 1),
  CONSTRAINT wallet_cache_drift_scan_state_shape CHECK (
    bucket_count BETWEEN 1 AND 10000
    AND next_bucket >= 0
    AND next_bucket < bucket_count
    AND lookback > interval '0'
  )
);

COMMENT ON TABLE public.wallet_cache_drift_scan_state IS
  'One-row cursor for repair_wallet_cache_drift. next_bucket is the hash slice scanned on the next run and advances by one run, including runs that stop on the 80s repair budget. bucket_count 72 covers every wallets_physical user once per 72 runs (18 hours at the 15-minute cron). lookback is the activity window; the function never uses less than 24 hours. Missed runs delay the cursor and do not skip a slice.';

COMMENT ON COLUMN public.wallet_cache_drift_scan_state.next_bucket IS
  'Slice index in [0, bucket_count). Reset to 0 in the same update that changes bucket_count.';

INSERT INTO public.wallet_cache_drift_scan_state (id, next_bucket, bucket_count, lookback)
VALUES (1, 0, 72, interval '24 hours');

ALTER TABLE public.wallet_cache_drift_scan_state ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.wallet_cache_drift_scan_state FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON TABLE public.wallet_cache_drift_scan_state TO service_role;

-- No client policy grants rows. The restrictive staff policy is a no-op until
-- staff_mfa_config.mode is admin or all. The repair function is SECURITY DEFINER
-- and owned by the table owner, so it reads and advances the cursor itself.
DROP POLICY IF EXISTS mfa_required_for_staff ON public.wallet_cache_drift_scan_state;
CREATE POLICY mfa_required_for_staff ON public.wallet_cache_drift_scan_state
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

CREATE OR REPLACE FUNCTION public.repair_wallet_cache_drift(p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET work_mem TO '64MB'
AS $function$
DECLARE
  v_row record;
  v_repaired int := 0;
  v_scanned  int := 0;
  v_deadline timestamptz := clock_timestamp() + interval '80 seconds';
  v_timed_out boolean := false;
  v_bucket int;
  v_bucket_count int;
  v_lookback interval;
  v_since timestamptz;
  v_ids uuid[];
  v_recent bigint := 0;
  v_slice bigint := 0;
  v_candidates int := 0;
BEGIN
  INSERT INTO public.wallet_cache_drift_scan_state AS s (id, next_bucket, bucket_count, lookback)
  VALUES (1, 0, 72, interval '24 hours')
  ON CONFLICT (id) DO NOTHING;

  SELECT s.next_bucket, s.bucket_count, s.lookback
    INTO v_bucket, v_bucket_count, v_lookback
    FROM public.wallet_cache_drift_scan_state s
   WHERE s.id = 1
   FOR UPDATE;

  IF v_lookback < interval '24 hours' THEN
    v_lookback := interval '24 hours';
  END IF;
  v_since := now() - v_lookback;

  WITH recent AS (
    SELECT g.user_id
      FROM (
        SELECT gl.user_id
          FROM public.general_ledger gl
         WHERE gl.created_at >= v_since
           AND gl.user_id IS NOT NULL
        UNION
        SELECT p.user_id
          FROM public.wallet_balances_projection p
         WHERE p.updated_at >= v_since
        UNION
        SELECT wp.user_id
          FROM public.wallets_physical wp
         WHERE wp.updated_at >= v_since
      ) g
      JOIN public.wallets_physical wp ON wp.user_id = g.user_id
  ),
  slice AS (
    SELECT wp.user_id
      FROM public.wallets_physical wp
     WHERE mod(
             mod(hashtextextended(wp.user_id::text, 0), v_bucket_count::bigint)
               + v_bucket_count::bigint,
             v_bucket_count::bigint
           ) = v_bucket::bigint
       AND NOT EXISTS (SELECT 1 FROM recent r WHERE r.user_id = wp.user_id)
  ),
  cand AS (
    SELECT recent.user_id, 1 AS src FROM recent
    UNION ALL
    SELECT slice.user_id, 2 AS src FROM slice
  )
  SELECT COALESCE(array_agg(user_id), ARRAY[]::uuid[]),
         count(*) FILTER (WHERE src = 1),
         count(*) FILTER (WHERE src = 2)
    INTO v_ids, v_recent, v_slice
    FROM cand;

  v_candidates := COALESCE(array_length(v_ids, 1), 0);

  IF v_candidates > 0 THEN
    FOR v_row IN
      WITH strict AS (
        SELECT *
          FROM public._wallet_strict_for_users_impl(v_ids)
      )
      SELECT c.user_id
        FROM unnest(v_ids) AS c(user_id)
        LEFT JOIN public.wallet_balances_projection p ON p.user_id = c.user_id
        JOIN strict s ON s.user_id = c.user_id
       WHERE ABS(COALESCE(p.withdrawable, 0) - COALESCE(s.withdrawable, 0)) >= 1
          OR ABS(COALESCE(p.float_balance, 0) - COALESCE(s.float_balance, 0)) >= 1
          OR ABS(COALESCE(p.advance_balance, 0) - COALESCE(s.advance_balance, 0)) >= 1
       LIMIT p_limit
    LOOP
      IF clock_timestamp() > v_deadline THEN
        v_timed_out := true;
        EXIT;
      END IF;
      v_scanned := v_scanned + 1;
      BEGIN
        PERFORM public.repair_wallet_cache_for_user(v_row.user_id);
        v_repaired := v_repaired + 1;
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END LOOP;
  END IF;

  UPDATE public.wallet_cache_drift_scan_state
     SET next_bucket = mod(v_bucket + 1, v_bucket_count),
         updated_at = now()
   WHERE id = 1;

  RETURN jsonb_build_object(
    'scanned', v_scanned,
    'repaired', v_repaired,
    'stopped_on_budget', v_timed_out,
    'ran_at', now(),
    'candidates', v_candidates,
    'recent_candidates', v_recent,
    'slice_candidates', v_slice,
    'bucket', v_bucket,
    'bucket_count', v_bucket_count,
    'lookback_seconds', extract(epoch FROM v_lookback)::int,
    'next_bucket', mod(v_bucket + 1, v_bucket_count)
  );
END;
$function$;

COMMENT ON FUNCTION public.repair_wallet_cache_drift(integer) IS
  'Repairs projection drift for a 24h activity set plus one hash slice of the other wallets_physical users. Cursor: wallet_cache_drift_scan_state. Full slice rotation is bucket_count runs (72 x 15 min = 18 hours).';

REVOKE ALL ON FUNCTION public.repair_wallet_cache_drift(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repair_wallet_cache_drift(integer) TO service_role;
