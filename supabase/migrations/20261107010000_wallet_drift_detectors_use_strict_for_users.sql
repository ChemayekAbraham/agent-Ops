-- =============================================================================
-- Migration: 20261107010000_wallet_drift_detectors_use_strict_for_users.sql
--
-- The three financial-integrity crons below all joined public.v_user_wallet_strict.
-- That view materialises the full wallet ledger (~98k wallets) before the join,
-- so a 251–1000 user outer set still paid for every wallet. They also all started
-- on minute 0, 15, 30 and 45, so the three full builds ran at once.
--
-- public._wallet_strict_for_users_impl(uuid[]) is the same balance math with
-- general_ledger.user_id = ANY (p_ids) applied first. Live definitions this
-- rewrite is based on (pg_get_functiondef, 2026-11-06):
--   detect_wallet_projection_drift              md5 016729b965e9ac8b98eb34636503b2fb
--   detect_credit_limit_reconciliation_drift    md5 2c2750657de5cccb36bd6c1bb043dcaf
--   repair_wallet_cache_drift                   md5 25a70fd8302238dc190d5954cdc2a3e7
--   _wallet_strict_for_users_impl               md5 93704d51cce6a475034dc6a1d547ca5c
--
-- public.wallets is the view
--   wallets_physical LEFT JOIN wallet_balances_projection
-- with withdrawable_balance / float_balance / advance_balance =
-- COALESCE(projection column, 0). Cached floats below use that expression.
-- A bare join to wallet_balances_projection is not the same: two
-- credit_access_limits users have a projection float and no physical wallet,
-- and the live detector (via wallets) does not see that float.
--
-- Unchanged: drift thresholds, severity, alert inserts, system_events,
-- the repair loop, the 80s budget, return shapes, SECURITY DEFINER,
-- search_path, work_mem, owner and EXECUTE grants. CREATE OR REPLACE keeps
-- the grants (postgres and service_role only) and the projection function's
-- comment. These functions are not dropped.
--
-- Schedules stay four times an hour. Credit stays on */15. Repair moves to
-- 5,20,35,50 and projection to 10,25,40,55 so the three jobs no longer start
-- together. Commands are not changed.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.detect_wallet_projection_drift(p_sample_size integer DEFAULT 500)
 RETURNS TABLE(users_checked bigint, users_drifted bigint, auto_healed bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET work_mem TO '64MB'
AS $function$
DECLARE
  v_checked bigint := 0;
  v_drifted bigint := 0;
BEGIN
  WITH sampled AS (
    SELECT user_id
    FROM public.wallet_balances_projection
    ORDER BY updated_at ASC
    LIMIT p_sample_size
  ),
  strict AS (
    SELECT *
    FROM public._wallet_strict_for_users_impl((SELECT array_agg(user_id) FROM sampled))
  ),
  compared AS (
    SELECT
      p.user_id,
      p.withdrawable AS p_w, p.float_balance AS p_f, p.advance_balance AS p_a,
      s.withdrawable AS s_w, s.float_balance AS s_f, s.advance_balance AS s_a
    FROM public.wallet_balances_projection p
    JOIN sampled ON sampled.user_id = p.user_id
    LEFT JOIN strict s ON s.user_id = p.user_id
  ),
  divergent AS (
    SELECT * FROM compared
    WHERE (COALESCE(p_w,0) - COALESCE(s_w,0)) <> 0
       OR (COALESCE(p_f,0) - COALESCE(s_f,0)) <> 0
       OR (COALESCE(p_a,0) - COALESCE(s_a,0)) <> 0
  ),
  logged AS (
    INSERT INTO public.wallet_projection_drift_alerts
      (user_id, projection_withdrawable, ledger_withdrawable,
       projection_float, ledger_float, projection_advance, ledger_advance, auto_healed)
    SELECT user_id, p_w, COALESCE(s_w,0), p_f, COALESCE(s_f,0), p_a, COALESCE(s_a,0), false
    FROM divergent
    RETURNING user_id
  )
  SELECT
    (SELECT count(*) FROM sampled),
    (SELECT count(*) FROM divergent)
  INTO v_checked, v_drifted;

  RETURN QUERY SELECT v_checked, v_drifted, 0::bigint;
END;
$function$;

CREATE OR REPLACE FUNCTION public.detect_credit_limit_reconciliation_drift()
 RETURNS TABLE(inserted_alerts integer, scanned_users integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
  v_expected_alloc numeric;
  v_alloc_total numeric;
  v_expected_total numeric;
  v_bonus_drift numeric;
  v_limit_drift numeric;
  v_float_drift numeric;
  v_severity text;
  v_inserted int := 0;
  v_scanned int := 0;
  v_last_id uuid;
  v_last_bonus numeric;
  v_last_limit numeric;
  v_last_float numeric;
BEGIN
  FOR r IN
    WITH cands AS (
      SELECT
        cal.user_id,
        cal.bonus_from_agent_allocations AS cached_bonus,
        cal.total_limit                   AS cached_total,
        COALESCE(p.float_balance, 0)      AS cached_float
      FROM public.credit_access_limits cal
      LEFT JOIN public.wallets_physical wp ON wp.user_id = cal.user_id
      LEFT JOIN public.wallet_balances_projection p ON p.user_id = wp.user_id
      WHERE cal.bonus_from_agent_allocations > 0
         OR COALESCE(p.float_balance, 0) <> 0
         OR EXISTS (SELECT 1 FROM (SELECT * FROM public.agent_collections WHERE reversed_at IS NULL) ac WHERE ac.agent_id = cal.user_id)
    ),
    strict AS (
      SELECT *
      FROM public._wallet_strict_for_users_impl((SELECT array_agg(user_id) FROM cands))
    )
    SELECT
      c.user_id,
      c.cached_bonus,
      c.cached_total,
      c.cached_float,
      COALESCE(s.float_balance, 0) AS ledger_float
    FROM cands c
    LEFT JOIN strict s ON s.user_id = c.user_id
  LOOP
    v_scanned := v_scanned + 1;

    SELECT COALESCE(SUM(amount), 0) INTO v_alloc_total
      FROM public.agent_collections WHERE reversed_at IS NULL AND agent_id = r.user_id;
    v_expected_alloc := LEAST(v_alloc_total * 2, 30000000);

    v_bonus_drift := r.cached_bonus - v_expected_alloc;
    v_expected_total := LEAST(GREATEST(r.cached_total - r.cached_bonus + v_expected_alloc, 0), 30000000);
    v_limit_drift := r.cached_total - v_expected_total;
    v_float_drift := r.cached_float - r.ledger_float;

    IF abs(v_bonus_drift) < 1 AND abs(v_limit_drift) < 1 AND abs(v_float_drift) < 1 THEN
      CONTINUE;
    END IF;

    SELECT id, bonus_drift, limit_drift, float_drift
      INTO v_last_id, v_last_bonus, v_last_limit, v_last_float
      FROM public.credit_limit_reconciliation_alerts
     WHERE user_id = r.user_id AND resolved_at IS NULL
     ORDER BY detected_at DESC LIMIT 1;

    IF v_last_id IS NOT NULL
       AND abs(v_last_bonus - v_bonus_drift) < 1
       AND abs(v_last_limit - v_limit_drift) < 1
       AND abs(v_last_float - v_float_drift) < 1 THEN
      CONTINUE;
    END IF;

    v_severity := CASE
      WHEN GREATEST(abs(v_bonus_drift), abs(v_limit_drift), abs(v_float_drift)) >= 1000000 THEN 'high'
      WHEN GREATEST(abs(v_bonus_drift), abs(v_limit_drift), abs(v_float_drift)) >= 100000 THEN 'medium'
      ELSE 'low'
    END;

    INSERT INTO public.credit_limit_reconciliation_alerts (
      user_id, cached_bonus_allocations, expected_bonus_allocations, bonus_drift,
      cached_total_limit, expected_total_limit, limit_drift,
      cached_float, ledger_float, float_drift, severity, details
    ) VALUES (
      r.user_id, r.cached_bonus, v_expected_alloc, v_bonus_drift,
      r.cached_total, v_expected_total, v_limit_drift,
      r.cached_float, r.ledger_float, v_float_drift, v_severity,
      jsonb_build_object('agent_collections_sum', v_alloc_total)
    );

    v_inserted := v_inserted + 1;

    IF v_severity = 'high' AND to_regclass('public.system_events') IS NOT NULL THEN
      BEGIN
        INSERT INTO public.system_events (event_type, payload, actor_id)
        VALUES (
          'credit_limit.drift_alert.raised',
          jsonb_build_object(
            'user_id', r.user_id,
            'bonus_drift', v_bonus_drift,
            'limit_drift', v_limit_drift,
            'float_drift', v_float_drift,
            'severity', v_severity
          ),
          r.user_id
        );
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_inserted, v_scanned;
END;
$function$;

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
BEGIN
  FOR v_row IN
    WITH phys AS (
      SELECT user_id FROM public.wallets_physical
    ),
    strict AS (
      SELECT *
      FROM public._wallet_strict_for_users_impl((SELECT array_agg(user_id) FROM phys))
    )
    SELECT wp.user_id
      FROM public.wallets_physical wp
      LEFT JOIN public.wallet_balances_projection p ON p.user_id = wp.user_id
      JOIN strict s ON s.user_id = wp.user_id
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

  RETURN jsonb_build_object('scanned', v_scanned, 'repaired', v_repaired,
                            'stopped_on_budget', v_timed_out, 'ran_at', now());
END;
$function$;

-- Four runs an hour, off minute 0. detect-credit-limit-drift-15min stays */15.
-- No-op when the named job is already off */15, or is absent (a from-scratch
-- replay never created repair-wallet-cache-drift-15m). Prod names checked
-- 2026-11-06: repair-wallet-cache-drift-15m, wallet-projection-drift.
DO $cron$
DECLARE
  v_id bigint;
BEGIN
  SELECT jobid INTO v_id
    FROM cron.job
   WHERE jobname = 'repair-wallet-cache-drift-15m'
     AND schedule = '*/15 * * * *';
  IF v_id IS NOT NULL THEN
    PERFORM cron.alter_job(v_id, schedule := '5,20,35,50 * * * *');
  END IF;

  SELECT jobid INTO v_id
    FROM cron.job
   WHERE jobname = 'wallet-projection-drift'
     AND schedule = '*/15 * * * *';
  IF v_id IS NOT NULL THEN
    PERFORM cron.alter_job(v_id, schedule := '10,25,40,55 * * * *');
  END IF;
END
$cron$;
