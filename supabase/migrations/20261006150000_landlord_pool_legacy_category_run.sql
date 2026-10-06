-- Landlord Float Pool: tag pre-cutover portfolios with their pool category (Option B).
--
-- Category only. No money moves: the run writes no ledger row, no pool entry and no
-- pool movement. Older portfolios keep pool_eligible = false (immutable), and every
-- pool money step gates on pool_eligible, so a category on an older portfolio never
-- reserves, deploys or releases anything.
--
-- Fired once by pg_cron at 20:00 EAT on 2026-10-06 (17:00 UTC), retrying every 5
-- minutes until 20:55 only if the run could not complete (e.g. lock timeout). It
-- removes its own cron job after the first success, and refuses to run outside the
-- window so the yearly-repeating cron expression can never fire it again.
--
-- Plan: docs/LEGACY_PORTFOLIOS_POOL_CATEGORY_PLAN.md
-- Requires 20261006150100_company_managed_allocation_requires_pool_eligible.sql
-- (applied first): otherwise tagging fires the company-managed house allocator.

-- 1. Run record and per-portfolio log (audit trail + undo list) ---------------------

CREATE TABLE IF NOT EXISTS public.landlord_pool_legacy_category_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at     timestamptz,
  mode            text NOT NULL CHECK (mode IN ('live', 'dry_run')),
  status          text NOT NULL CHECK (status IN ('succeeded', 'failed', 'skipped', 'expired')),
  rows_updated    integer,
  before_snapshot jsonb,
  after_snapshot  jsonb,
  error           text
);

CREATE TABLE IF NOT EXISTS public.landlord_pool_legacy_category_log (
  run_id         uuid NOT NULL REFERENCES public.landlord_pool_legacy_category_runs(id),
  portfolio_id   uuid NOT NULL REFERENCES public.investor_portfolios(id),
  portfolio_code text,
  origin         text NOT NULL CHECK (origin IN ('self_support', 'company_managed')),
  status         text,
  principal      numeric,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, portfolio_id)
);

ALTER TABLE public.landlord_pool_legacy_category_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landlord_pool_legacy_category_log  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.landlord_pool_legacy_category_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.landlord_pool_legacy_category_log  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.landlord_pool_legacy_category_runs TO service_role;
GRANT SELECT ON public.landlord_pool_legacy_category_log  TO service_role;

-- 2. Snapshot (one statement = one consistent view) ---------------------------------

CREATE OR REPLACE FUNCTION public._landlord_pool_legacy_snapshot()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH bal AS (
    SELECT m.account_code,
           SUM(CASE WHEN gl.direction = m.debit_when THEN gl.amount ELSE -gl.amount END) AS v
      FROM general_ledger gl
      JOIN ledger_account_map m
        ON m.ledger_scope = gl.ledger_scope AND m.category = gl.category AND m.wallet_bucket IS NULL
     WHERE m.account_code IN ('A1', 'A21', 'A22')
     GROUP BY 1
  ), sub AS (
    SELECT origin, SUM(in_pool) AS v FROM landlord_pool_entries GROUP BY 1
  )
  SELECT jsonb_build_object(
    'at', clock_timestamp(),
    'A1',  (SELECT v FROM bal WHERE account_code = 'A1'),
    'A21', (SELECT v FROM bal WHERE account_code = 'A21'),
    'A22', (SELECT v FROM bal WHERE account_code = 'A22'),
    'tie_diff_self_support',
      coalesce((SELECT v FROM bal WHERE account_code = 'A21'), 0) - coalesce((SELECT v FROM sub WHERE origin = 'self_support'), 0),
    'tie_diff_company_managed',
      coalesce((SELECT v FROM bal WHERE account_code = 'A22'), 0) - coalesce((SELECT v FROM sub WHERE origin = 'company_managed'), 0),
    'open_exceptions', (SELECT count(*) FROM landlord_pool_exceptions WHERE resolved_at IS NULL),
    'pool_eligible_true', (SELECT count(*) FROM investor_portfolios WHERE pool_eligible),
    'older_by_status_category', (
      SELECT jsonb_agg(jsonb_build_object('status', status, 'category', pool_origin, 'n', n, 'principal', amt)
                       ORDER BY status, pool_origin)
        FROM (SELECT status, pool_origin, count(*) n, sum(investment_amount) amt
                FROM investor_portfolios WHERE NOT pool_eligible GROUP BY 1, 2) t)
  );
$$;

-- 3. The run ------------------------------------------------------------------------
-- p_dry_run = true: does everything, then rolls back its own work (via an exception
-- inside the block) and records a 'dry_run' row with the outcome.

CREATE OR REPLACE FUNCTION public.landlord_pool_categorise_legacy_portfolios(p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  c_job        constant text := 'landlord-pool-legacy-category-once';
  c_window_end constant timestamptz := '2026-10-06 18:00:00+00';  -- 21:00 EAT
  v_mode   text := CASE WHEN p_dry_run THEN 'dry_run' ELSE 'live' END;
  v_run    uuid := gen_random_uuid();
  v_before jsonb;
  v_after  jsonb;
  v_n      integer;
  v_logged integer;
  v_left   integer;
  v_gl     integer;
  v_mv     integer;
  v_ex     integer;
  v_cl     integer;
  v_pa     integer;
  v_err    text;
BEGIN
  -- Already done: never run twice.
  IF NOT p_dry_run AND EXISTS (SELECT 1 FROM landlord_pool_legacy_category_runs
                                WHERE mode = 'live' AND status = 'succeeded') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = c_job;
    INSERT INTO landlord_pool_legacy_category_runs (id, mode, status, finished_at, error)
    VALUES (v_run, v_mode, 'skipped', clock_timestamp(), 'already succeeded');
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'already succeeded');
  END IF;

  -- Outside the window: the cron expression repeats yearly, so refuse and remove it.
  IF NOT p_dry_run AND now() > c_window_end THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = c_job;
    INSERT INTO landlord_pool_legacy_category_runs (id, mode, status, finished_at, error)
    VALUES (v_run, v_mode, 'expired', clock_timestamp(), 'outside the scheduled window');
    RETURN jsonb_build_object('status', 'expired');
  END IF;

  BEGIN
    PERFORM set_config('lock_timeout', '10s', true);

    v_before := _landlord_pool_legacy_snapshot();

    INSERT INTO landlord_pool_legacy_category_runs (id, mode, status, before_snapshot)
    VALUES (v_run, v_mode, 'failed', v_before);  -- flipped to succeeded at the end

    -- Category rule: a portfolio that came from supporting a tenant or a house is
    -- self-support; everything else (nothing attached) is company-managed.
    INSERT INTO landlord_pool_legacy_category_log (run_id, portfolio_id, portfolio_code, origin, status, principal)
    SELECT v_run, ip.id, ip.portfolio_code,
           CASE WHEN EXISTS (SELECT 1 FROM funder_pending_portfolios f
                              WHERE f.portfolio_id = ip.id AND f.source IN ('self_managed', 'self_managed_house'))
                  OR EXISTS (SELECT 1 FROM partner_supported_houses h WHERE h.portfolio_id = ip.id)
                THEN 'self_support' ELSE 'company_managed' END,
           ip.status, ip.investment_amount
      FROM investor_portfolios ip
     WHERE NOT ip.pool_eligible AND ip.pool_origin IS NULL
     FOR UPDATE OF ip;
    GET DIAGNOSTICS v_logged = ROW_COUNT;

    -- Only the category field is written.
    UPDATE investor_portfolios ip
       SET pool_origin = l.origin
      FROM landlord_pool_legacy_category_log l
     WHERE l.run_id = v_run AND l.portfolio_id = ip.id
       AND NOT ip.pool_eligible AND ip.pool_origin IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;

    v_after := _landlord_pool_legacy_snapshot();

    -- Rows written by THIS transaction carry created_at = now() (its start time).
    SELECT count(*) INTO v_gl FROM general_ledger            WHERE created_at = now();
    SELECT count(*) INTO v_mv FROM landlord_pool_movements   WHERE created_at = now();
    SELECT count(*) INTO v_ex FROM landlord_pool_exceptions  WHERE created_at = now();
    SELECT count(*) INTO v_cl FROM portfolio_change_log      WHERE created_at = now();
    SELECT count(*) INTO v_pa FROM portfolio_allocations     WHERE created_at = now();
    SELECT count(*) INTO v_left FROM investor_portfolios WHERE NOT pool_eligible AND pool_origin IS NULL;

    IF v_gl <> 0 THEN RAISE EXCEPTION 'CHECK_FAILED: % ledger rows written', v_gl; END IF;
    IF v_mv <> 0 THEN RAISE EXCEPTION 'CHECK_FAILED: % pool movements written', v_mv; END IF;
    IF v_ex <> 0 THEN RAISE EXCEPTION 'CHECK_FAILED: % pool exceptions written', v_ex; END IF;
    IF v_cl <> 0 THEN RAISE EXCEPTION 'CHECK_FAILED: % change-log rows written', v_cl; END IF;
    -- Older portfolios must never claim houses (20261006150100 guard).
    IF v_pa <> 0 THEN RAISE EXCEPTION 'CHECK_FAILED: % house claims written', v_pa; END IF;
    IF v_n <> v_logged THEN RAISE EXCEPTION 'CHECK_FAILED: updated % but logged %', v_n, v_logged; END IF;
    IF v_left <> 0 THEN RAISE EXCEPTION 'CHECK_FAILED: % older portfolios left untagged', v_left; END IF;
    -- New portfolios may be created meanwhile (count can rise); it must never fall.
    IF (v_after->>'pool_eligible_true')::int < (v_before->>'pool_eligible_true')::int THEN
      RAISE EXCEPTION 'CHECK_FAILED: pool_eligible stamps decreased';
    END IF;
    IF (v_after->>'tie_diff_self_support')::numeric <> (v_before->>'tie_diff_self_support')::numeric
       OR (v_after->>'tie_diff_company_managed')::numeric <> (v_before->>'tie_diff_company_managed')::numeric THEN
      RAISE EXCEPTION 'CHECK_FAILED: books vs pool records moved (before %, after %)',
        jsonb_build_array(v_before->'tie_diff_self_support', v_before->'tie_diff_company_managed'),
        jsonb_build_array(v_after->'tie_diff_self_support', v_after->'tie_diff_company_managed');
    END IF;

    UPDATE landlord_pool_legacy_category_runs
       SET status = 'succeeded', finished_at = clock_timestamp(), rows_updated = v_n, after_snapshot = v_after
     WHERE id = v_run;

    IF p_dry_run THEN
      RAISE EXCEPTION 'DRY_RUN_ROLLBACK';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    -- Everything inside the block is rolled back. Record the attempt.
    INSERT INTO landlord_pool_legacy_category_runs
      (id, mode, status, finished_at, rows_updated, before_snapshot, after_snapshot, error)
    VALUES (v_run, v_mode,
            CASE WHEN v_err = 'DRY_RUN_ROLLBACK' THEN 'succeeded' ELSE 'failed' END,
            clock_timestamp(), v_n, v_before, v_after,
            CASE WHEN v_err = 'DRY_RUN_ROLLBACK' THEN 'dry run: rolled back' ELSE v_err END);
    RETURN jsonb_build_object('status', CASE WHEN v_err = 'DRY_RUN_ROLLBACK' THEN 'dry_run_ok' ELSE 'failed' END,
                              'run_id', v_run, 'rows', v_n, 'error', v_err,
                              'before', v_before, 'after', v_after);
  END;

  -- Live success: remove the job so it never fires again.
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = c_job;
  RETURN jsonb_build_object('status', 'succeeded', 'run_id', v_run, 'rows', v_n,
                            'before', v_before, 'after', v_after);
END;
$$;

REVOKE ALL ON FUNCTION public._landlord_pool_legacy_snapshot() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.landlord_pool_categorise_legacy_portfolios(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._landlord_pool_legacy_snapshot() TO service_role;
GRANT EXECUTE ON FUNCTION public.landlord_pool_categorise_legacy_portfolios(boolean) TO service_role;

-- 4. Report: every portfolio by pool category ----------------------------------------

CREATE OR REPLACE VIEW public.v_portfolio_pool_category
WITH (security_invoker = true) AS
SELECT ip.id                 AS portfolio_id,
       ip.portfolio_code,
       ip.investor_id        AS partner_id,
       ip.status,
       ip.pool_origin        AS category,
       ip.pool_eligible,
       (e.portfolio_id IS NOT NULL) AS cash_in_pool,
       ip.investment_amount  AS live_principal,
       coalesce(e.reserved, 0)         AS pool_reserved,
       coalesce(e.in_pool, 0)          AS pool_in_pool,
       coalesce(e.out_with_tenants, 0) AS pool_out_with_tenants,
       coalesce(e.released, 0)         AS pool_released
  FROM public.investor_portfolios ip
  LEFT JOIN (
    SELECT portfolio_id,
           sum(principal) AS reserved, sum(in_pool) AS in_pool,
           sum(out_with_tenants) AS out_with_tenants, sum(released) AS released
      FROM public.landlord_pool_entries
     WHERE portfolio_id IS NOT NULL
     GROUP BY 1
  ) e ON e.portfolio_id = ip.id;

REVOKE ALL ON public.v_portfolio_pool_category FROM PUBLIC, anon;
GRANT SELECT ON public.v_portfolio_pool_category TO authenticated, service_role;

-- 5. Schedule: 20:00 EAT on 6 Oct 2026, retry every 5 min to 20:55 ------------------
-- pg_cron runs in GMT here. The function removes the job after success and refuses
-- to run after the window, so the yearly repeat of this expression is harmless.

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'landlord-pool-legacy-category-once';
SELECT cron.schedule(
  'landlord-pool-legacy-category-once',
  '0-55/5 17 6 10 *',
  $cron$ SELECT public.landlord_pool_categorise_legacy_portfolios(false); $cron$
);
