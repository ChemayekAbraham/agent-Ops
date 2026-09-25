-- Tenant Ops "Weekly Performance" dashboard: Wed->Tue reporting week metrics,
-- frozen into a real per-week ledger so history never drifts.
--
-- Reuses, does not reinvent:
--   * tppo_period_bounds('week', anchor) for the Wed->Tue boundary math -- the
--     same function WeeklyArrearsSheet.tsx / WeeklyStaffForwardingReport.tsx /
--     the TPPO arrears report already use.
--   * v_tenant_ops_tenant_base.is_active (funded/repaying, agent_payment_status
--     <> 'not_paying') for "active tenant" -- the one-row-per-tenant flag
--     already computed for Tenant Ops, not the looser status list used by
--     activeTenantsReportPdf.ts.
--   * v_tenant_ops_tenant_base.tenant_created_at for "new tenant" (same source
--     get_tenant_ops_acquisition() already uses), bucketed to the business
--     week instead of a calendar day/week.
--   * agent_collections UNION repayments for "made a payment" -- the same
--     union v_rent_plan_schedule's internal last-payment CTE already relies
--     on, deliberately NOT v_tenant_ops_tenant_base.last_payment_at, which
--     only looks at agent_collections and misses tenant self-payments
--     recorded straight into repayments.
--   * the pin_agent_expected_day() "insert ... on conflict do nothing" freeze
--     idiom -- a week is written once, after it has fully closed, and never
--     overwritten, so "Week 1, Week 2, Week 3" never move once reported.
--   * the same authorization check get_tenant_ops_acquisition() already uses.

CREATE TABLE IF NOT EXISTS public.tenant_ops_weekly_metrics (
  week_start date PRIMARY KEY,
  week_end date NOT NULL,
  total_active_tenants integer NOT NULL DEFAULT 0,
  paying_tenants integer NOT NULL DEFAULT 0,
  non_paying_tenants integer NOT NULL DEFAULT 0,
  new_tenants_added integer NOT NULL DEFAULT 0,
  payment_rate_pct numeric NOT NULL DEFAULT 0,
  captured_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON public.tenant_ops_weekly_metrics FROM PUBLIC, authenticated;

COMMENT ON TABLE public.tenant_ops_weekly_metrics IS
'One frozen row per Wed->Tue reporting week. Written once by pin_tenant_ops_weekly_metrics() after the week has closed; never updated after that (ON CONFLICT DO NOTHING). Read only through get_tenant_ops_weekly_performance()/get_tenant_ops_weekly_history() -- no direct grants.';

-- Live computation for any [week_start, week_end] range. Internal only: never
-- granted directly, only called from the SECURITY DEFINER functions below.
CREATE OR REPLACE FUNCTION public._tenant_ops_weekly_metrics_raw(p_week_start date, p_week_end date)
RETURNS TABLE(
  total_active_tenants integer,
  paying_tenants integer,
  non_paying_tenants integer,
  new_tenants_added integer,
  payment_rate_pct numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH active AS (
    SELECT tenant_id FROM public.v_tenant_ops_tenant_base WHERE is_active
  ),
  paid_this_week AS (
    SELECT DISTINCT x.tenant_id
      FROM (
        SELECT tenant_id, created_at FROM public.agent_collections WHERE tenant_id IS NOT NULL
        UNION ALL
        SELECT tenant_id, created_at FROM public.repayments WHERE tenant_id IS NOT NULL
      ) x
     WHERE (x.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_week_start AND p_week_end
  ),
  new_this_week AS (
    SELECT tenant_id FROM public.v_tenant_ops_tenant_base
     WHERE (tenant_created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_week_start AND p_week_end
  ),
  active_count AS (SELECT count(*)::int AS n FROM active),
  paying_count AS (
    SELECT count(*)::int AS n FROM active a
     WHERE EXISTS (SELECT 1 FROM paid_this_week p WHERE p.tenant_id = a.tenant_id)
  )
  SELECT
    (SELECT n FROM active_count),
    (SELECT n FROM paying_count),
    (SELECT n FROM active_count) - (SELECT n FROM paying_count),
    (SELECT count(*)::int FROM new_this_week),
    CASE WHEN (SELECT n FROM active_count) > 0
      THEN round((SELECT n FROM paying_count)::numeric / (SELECT n FROM active_count)::numeric * 100, 1)
      ELSE 0::numeric END;
$$;

-- Freeze one week's numbers, once, after it has fully closed. First call for a
-- week wins; later calls (including an accidental re-run) are no-ops -- same
-- guarantee pin_agent_expected_day() gives per-day figures.
CREATE OR REPLACE FUNCTION public.pin_tenant_ops_weekly_metrics(p_anchor date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_anchor date := COALESCE(p_anchor, v_today - 7);
  v_start date;
  v_end date;
  v_row record;
  v_inserted integer := 0;
BEGIN
  SELECT period_start, period_end INTO v_start, v_end
    FROM public.tppo_period_bounds('week', v_anchor);

  -- Never freeze a week that has not fully closed yet.
  IF v_end >= v_today THEN
    RETURN 0;
  END IF;

  SELECT * INTO v_row FROM public._tenant_ops_weekly_metrics_raw(v_start, v_end);

  INSERT INTO public.tenant_ops_weekly_metrics (
    week_start, week_end, total_active_tenants, paying_tenants,
    non_paying_tenants, new_tenants_added, payment_rate_pct
  ) VALUES (
    v_start, v_end, v_row.total_active_tenants, v_row.paying_tenants,
    v_row.non_paying_tenants, v_row.new_tenants_added, v_row.payment_rate_pct
  )
  ON CONFLICT (week_start) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

-- Backfill any recently-closed weeks the Wednesday cron missed, same shape as
-- pin_agent_expected_day_catchup().
CREATE OR REPLACE FUNCTION public.pin_tenant_ops_weekly_metrics_catchup(p_lookback_weeks integer DEFAULT 8)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_pinned integer := 0;
  i integer;
BEGIN
  FOR i IN 0..GREATEST(p_lookback_weeks, 0) LOOP
    v_pinned := v_pinned + COALESCE(public.pin_tenant_ops_weekly_metrics(v_today - (i * 7)), 0);
  END LOOP;
  RETURN jsonb_build_object('status', 'ok', 'as_of', v_today, 'weeks_pinned', v_pinned);
END;
$$;

-- The main read: current (open, live-computed) week + previous (closed,
-- frozen) week + the deltas between them.
CREATE OR REPLACE FUNCTION public.get_tenant_ops_weekly_performance(p_anchor date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_anchor date := COALESCE(p_anchor, v_today);
  v_cur_start date;
  v_cur_end date;
  v_prev_start date;
  v_prev_end date;
  v_cur record;
  v_prev record;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT period_start, period_end INTO v_cur_start, v_cur_end
    FROM public.tppo_period_bounds('week', v_anchor);
  v_prev_start := v_cur_start - 7;
  v_prev_end := v_cur_end - 7;

  -- Current week: read the frozen row only once it has actually closed;
  -- an in-progress week is always computed live, never frozen early.
  IF v_cur_end < v_today THEN
    SELECT total_active_tenants, paying_tenants, non_paying_tenants, new_tenants_added, payment_rate_pct
      INTO v_cur
      FROM public.tenant_ops_weekly_metrics WHERE week_start = v_cur_start;
    IF NOT FOUND THEN
      SELECT * INTO v_cur FROM public._tenant_ops_weekly_metrics_raw(v_cur_start, v_cur_end);
    END IF;
  ELSE
    SELECT * INTO v_cur FROM public._tenant_ops_weekly_metrics_raw(v_cur_start, v_cur_end);
  END IF;

  -- Previous week is always closed by definition -- read frozen, pinning it
  -- on the fly (pin-on-read) if the Wednesday cron has not caught up yet.
  SELECT total_active_tenants, paying_tenants, non_paying_tenants, new_tenants_added, payment_rate_pct
    INTO v_prev
    FROM public.tenant_ops_weekly_metrics WHERE week_start = v_prev_start;
  IF NOT FOUND THEN
    PERFORM public.pin_tenant_ops_weekly_metrics(v_prev_start);
    SELECT total_active_tenants, paying_tenants, non_paying_tenants, new_tenants_added, payment_rate_pct
      INTO v_prev
      FROM public.tenant_ops_weekly_metrics WHERE week_start = v_prev_start;
    IF NOT FOUND THEN
      SELECT * INTO v_prev FROM public._tenant_ops_weekly_metrics_raw(v_prev_start, v_prev_end);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'week_start', v_cur_start,
    'week_end', v_cur_end,
    'is_current_week_open', (v_cur_end >= v_today),
    'current', jsonb_build_object(
      'total_active_tenants', v_cur.total_active_tenants,
      'paying_tenants', v_cur.paying_tenants,
      'non_paying_tenants', v_cur.non_paying_tenants,
      'new_tenants_added', v_cur.new_tenants_added,
      'payment_rate_pct', v_cur.payment_rate_pct
    ),
    'previous', jsonb_build_object(
      'week_start', v_prev_start,
      'week_end', v_prev_end,
      'total_active_tenants', v_prev.total_active_tenants,
      'paying_tenants', v_prev.paying_tenants,
      'non_paying_tenants', v_prev.non_paying_tenants,
      'new_tenants_added', v_prev.new_tenants_added,
      'payment_rate_pct', v_prev.payment_rate_pct
    ),
    'delta', jsonb_build_object(
      'total_active_tenants', v_cur.total_active_tenants - v_prev.total_active_tenants,
      'paying_tenants', v_cur.paying_tenants - v_prev.paying_tenants,
      'non_paying_tenants', v_cur.non_paying_tenants - v_prev.non_paying_tenants,
      'new_tenants_added', v_cur.new_tenants_added - v_prev.new_tenants_added,
      'payment_rate_pct', round(v_cur.payment_rate_pct - v_prev.payment_rate_pct, 1)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_tenant_ops_weekly_performance(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_tenant_ops_weekly_performance(date) TO authenticated;

-- Historical weekly records ("Week 1, Week 2, Week 3...") -- straight reads
-- of the frozen ledger, newest first.
CREATE OR REPLACE FUNCTION public.get_tenant_ops_weekly_history(p_limit integer DEFAULT 12)
RETURNS SETOF public.tenant_ops_weekly_metrics
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT *
    FROM public.tenant_ops_weekly_metrics
   WHERE auth.uid() IS NOT NULL
     AND (
       public.is_ops_role(auth.uid())
       OR public.has_role(auth.uid(), 'manager')
       OR public.has_role(auth.uid(), 'super_admin')
       OR public.has_role(auth.uid(), 'cto')
       OR public.has_role(auth.uid(), 'ceo')
       OR public.has_role(auth.uid(), 'coo')
     )
   ORDER BY week_start DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 104);
$$;

REVOKE ALL ON FUNCTION public.get_tenant_ops_weekly_history(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_tenant_ops_weekly_history(integer) TO authenticated;

-- Wednesday 00:10 EAT (21:10 UTC Tuesday) -- same "just after Kampala
-- midnight" convention as pin-agent-expected-day-eat-midnight (21:05 UTC
-- daily). Looks back 2 weeks for resilience against a missed run.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pin-tenant-ops-weekly-metrics-eat-wed') THEN
    PERFORM cron.schedule(
      'pin-tenant-ops-weekly-metrics-eat-wed',
      '10 21 * * 2',
      $cron$SELECT public.pin_tenant_ops_weekly_metrics_catchup(2);$cron$
    );
  END IF;
END
$do$;
