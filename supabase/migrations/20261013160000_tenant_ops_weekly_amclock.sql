-- Tenant Ops Weekly Performance on the shared payout clock.
--
-- The Wednesday-to-Tuesday weekly figures used to start every Rent Plan from repayment_starts_on /
-- funded_at (v_tenant_ops_tenant_base, v_rent_plan_schedule) and ignored landlord payouts. This adds NEW
-- read-only functions that count each Rent Plan only from its am_plan_clock start (the Kampala day AFTER
-- the last counted landlord payout), exactly as Agent Monitoring does.
--
-- NOTHING existing is edited: not v_tenant_ops_tenant_base, not v_rent_plan_schedule (top-up eligibility
-- shares it), not _tenant_ops_weekly_metrics_raw, get_tenant_ops_weekly_performance, get_tenant_ops_weekly_history,
-- pin_tenant_ops_weekly_metrics(_catchup), not tenant_ops_weekly_metrics (the frozen weeks) and not the
-- existing cron job.
--
-- Counting rules (week s..e, as_at = least(e, today in Kampala)):
--   * counted ("active") plan   : the tenant's latest live plan (is_active, as before) whose am_plan_clock
--                                 bucket is counting or outstanding_balance and whose clock_start <= as_at
--   * landlord_not_paid_count   : live plans in tenant_paying_no_landlord / awaiting_landlord. They owe nothing,
--                                 so they are in no other figure (not active, not non-paying, not 20+ days)
--   * paying                    : counted plans with a payment (non-reversed collection or repayment) in s..e
--                                 dated on or after the clock_start
--   * non-paying                : counted - paying;  payment rate = paying / counted
--   * 20+ days without payment  : counted plans with a balance whose last payment (or the clock_start when
--                                 none since) is 20 or more days ago. Days before the clock_start never count.
--   * new tenants, self-payment : unchanged
--
-- Weeks: the first week counted this way is the week open when this was applied (Wed 7 Oct 2026). Every
-- earlier week stays exactly as recorded in tenant_ops_weekly_metrics (read, never rebuilt or overwritten).
-- Weeks from 7 Oct 2026 on are frozen in a NEW table, tenant_ops_weekly_metrics_amclock, by a NEW cron job.
-- The old cron job keeps writing its own row for those weeks into the old table; the new functions ignore it.

-- 1. Frozen weeks counted the new way.
CREATE TABLE IF NOT EXISTS public.tenant_ops_weekly_metrics_amclock (
  week_start            date PRIMARY KEY,
  week_end              date NOT NULL,
  total_active_tenants  integer NOT NULL,
  paying_tenants        integer NOT NULL,
  non_paying_tenants    integer NOT NULL,
  new_tenants_added     integer NOT NULL,
  payment_rate_pct      numeric NOT NULL,
  self_payment_tenants  integer NOT NULL,
  dormant_20_plus_count integer NOT NULL,
  landlord_not_paid_count integer NOT NULL,
  captured_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.tenant_ops_weekly_metrics_amclock ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenant_ops_weekly_metrics_amclock FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.tenant_ops_weekly_metrics_amclock IS
  'One frozen row per Wed->Tue week from 2026-10-07, counted from am_plan_clock. Written once by pin_tenant_ops_weekly_metrics_amclock() after the week has closed (ON CONFLICT DO NOTHING). Read only through get_tenant_ops_weekly_performance_amclock()/get_tenant_ops_weekly_history_amclock().';

-- 2. The first week counted the new way.
CREATE OR REPLACE FUNCTION public._tenant_ops_weekly_amclock_first_week()
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $function$ SELECT DATE '2026-10-07'; $function$;

-- 3. One row per live plan for a week: whether it is counted, paying, dormant, or landlord-not-paid.
CREATE OR REPLACE FUNCTION public._tenant_ops_weekly_amclock_plans(p_week_start date, p_week_end date)
RETURNS TABLE (
  tenant_id         uuid,
  rent_request_id   uuid,
  bucket            text,
  clock_start       date,
  counted           boolean,
  landlord_not_paid boolean,
  paying            boolean,
  dormant           boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH today AS (
    SELECT (now() AT TIME ZONE 'Africa/Kampala')::date AS d
  ),
  asat AS (
    SELECT LEAST(p_week_end, t.d) AS d, t.d AS today FROM today t
  ),
  live AS (
    SELECT b.tenant_id, b.rent_request_id, b.outstanding
      FROM public.v_tenant_ops_tenant_base b
     WHERE b.is_active AND b.rent_request_id IS NOT NULL
  ),
  clk AS (
    SELECT * FROM public._am_plan_clock_core(ARRAY(SELECT l.rent_request_id FROM live l))
  ),
  pay AS (
    SELECT x.tenant_id, x.rent_request_id, x.day
      FROM (
        SELECT ac.tenant_id, ac.rent_request_id,
               (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS day
          FROM public.agent_collections ac
         WHERE ac.reversed_at IS NULL
           AND (ac.tenant_id IN (SELECT l.tenant_id FROM live l)
                OR ac.rent_request_id IN (SELECT l.rent_request_id FROM live l))
        UNION ALL
        SELECT rp.tenant_id, rp.rent_request_id,
               (rp.created_at AT TIME ZONE 'Africa/Kampala')::date
          FROM public.repayments rp
         WHERE (rp.tenant_id IN (SELECT l.tenant_id FROM live l)
                OR rp.rent_request_id IN (SELECT l.rent_request_id FROM live l))
      ) x
  ),
  plan AS (
    SELECT l.tenant_id, l.rent_request_id, l.outstanding, c.bucket, c.clock_start,
           (c.bucket IN ('counting', 'outstanding_balance')
              AND c.clock_start IS NOT NULL
              AND c.clock_start <= (SELECT a.d FROM asat a)) AS counted
      FROM live l
      JOIN clk c ON c.rent_request_id = l.rent_request_id
  )
  SELECT p.tenant_id,
         p.rent_request_id,
         p.bucket,
         p.clock_start,
         p.counted,
         (p.bucket IN ('tenant_paying_no_landlord', 'awaiting_landlord')),
         (p.counted AND EXISTS (
            SELECT 1 FROM pay y
             WHERE y.tenant_id = p.tenant_id
               AND y.day BETWEEN p_week_start AND p_week_end
               AND y.day >= p.clock_start)),
         (p.counted AND p.outstanding > 0 AND
            ((SELECT a.today FROM asat a) -
             GREATEST(p.clock_start,
                      COALESCE((SELECT max(y.day) FROM pay y WHERE y.rent_request_id = p.rent_request_id),
                               p.clock_start))) >= 20)
    FROM plan p;
$function$;

-- 4. The week's figures: same columns as _tenant_ops_weekly_metrics_raw plus landlord_not_paid_count.
CREATE OR REPLACE FUNCTION public._tenant_ops_weekly_metrics_raw_amclock(p_week_start date, p_week_end date)
RETURNS TABLE (
  total_active_tenants    integer,
  paying_tenants          integer,
  non_paying_tenants      integer,
  new_tenants_added       integer,
  payment_rate_pct        numeric,
  self_payment_tenants    integer,
  dormant_20_plus_count   integer,
  landlord_not_paid_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH w AS (
    SELECT * FROM public._tenant_ops_weekly_amclock_plans(p_week_start, p_week_end)
  ),
  new_this_week AS (
    SELECT tenant_id FROM public.v_tenant_ops_tenant_base
     WHERE (tenant_created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_week_start AND p_week_end
  ),
  self_payers_this_week AS (
    SELECT DISTINCT tenant_id
      FROM public.tenant_self_repayment_attempts
     WHERE outcome = 'settled'
       AND (created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_week_start AND p_week_end
  ),
  n AS (
    SELECT count(*) FILTER (WHERE counted)::int            AS active,
           count(*) FILTER (WHERE paying)::int             AS paying,
           count(*) FILTER (WHERE dormant)::int            AS dormant,
           count(*) FILTER (WHERE landlord_not_paid)::int  AS lnp
      FROM w
  )
  SELECT n.active,
         n.paying,
         n.active - n.paying,
         (SELECT count(*)::int FROM new_this_week),
         CASE WHEN n.active > 0 THEN round(n.paying::numeric / n.active::numeric * 100, 1) ELSE 0::numeric END,
         (SELECT count(*)::int FROM self_payers_this_week),
         n.dormant,
         n.lnp
    FROM n;
$function$;

-- 5. Freeze a closed week the new way. Never writes a week before the first new-way week.
CREATE OR REPLACE FUNCTION public.pin_tenant_ops_weekly_metrics_amclock(p_anchor date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_anchor date := COALESCE(p_anchor, v_today - 7);
  v_start date;
  v_end date;
  v_row record;
  v_inserted integer := 0;
BEGIN
  SELECT period_start, period_end INTO v_start, v_end FROM public.tppo_period_bounds('week', v_anchor);

  IF v_end >= v_today OR v_start < public._tenant_ops_weekly_amclock_first_week() THEN
    RETURN 0;
  END IF;

  SELECT * INTO v_row FROM public._tenant_ops_weekly_metrics_raw_amclock(v_start, v_end);

  INSERT INTO public.tenant_ops_weekly_metrics_amclock (
    week_start, week_end, total_active_tenants, paying_tenants, non_paying_tenants, new_tenants_added,
    payment_rate_pct, self_payment_tenants, dormant_20_plus_count, landlord_not_paid_count
  ) VALUES (
    v_start, v_end, v_row.total_active_tenants, v_row.paying_tenants, v_row.non_paying_tenants,
    v_row.new_tenants_added, v_row.payment_rate_pct, v_row.self_payment_tenants,
    v_row.dormant_20_plus_count, v_row.landlord_not_paid_count
  )
  ON CONFLICT (week_start) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$function$;

CREATE OR REPLACE FUNCTION public.pin_tenant_ops_weekly_metrics_amclock_catchup(p_lookback_weeks integer DEFAULT 2)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_pinned integer := 0;
  i integer;
BEGIN
  FOR i IN 0..GREATEST(p_lookback_weeks, 0) LOOP
    v_pinned := v_pinned + COALESCE(public.pin_tenant_ops_weekly_metrics_amclock(v_today - (i * 7)), 0);
  END LOOP;
  RETURN jsonb_build_object('status', 'ok', 'as_of', v_today, 'weeks_pinned', v_pinned);
END;
$function$;

-- 6. One week's figures and which way it was counted.
--    Weeks before the first new-way week: the frozen row as recorded (or, if there is none, the old live count).
--    Weeks from the first new-way week: the new frozen row once closed, the live new count while open.
CREATE OR REPLACE FUNCTION public._tenant_ops_weekly_amclock_week(p_week_start date, p_week_end date)
RETURNS TABLE (
  total_active_tenants    integer,
  paying_tenants          integer,
  non_paying_tenants      integer,
  new_tenants_added       integer,
  payment_rate_pct        numeric,
  self_payment_tenants    integer,
  dormant_20_plus_count   integer,
  landlord_not_paid_count integer,
  counting                text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_first date := public._tenant_ops_weekly_amclock_first_week();
BEGIN
  IF p_week_start < v_first THEN
    RETURN QUERY
      SELECT m.total_active_tenants, m.paying_tenants, m.non_paying_tenants, m.new_tenants_added,
             m.payment_rate_pct, m.self_payment_tenants, m.dormant_20_plus_count, NULL::integer, 'old'::text
        FROM public.tenant_ops_weekly_metrics m WHERE m.week_start = p_week_start;
    IF NOT FOUND THEN
      RETURN QUERY
        SELECT r.total_active_tenants, r.paying_tenants, r.non_paying_tenants, r.new_tenants_added,
               r.payment_rate_pct, r.self_payment_tenants, r.dormant_20_plus_count, NULL::integer, 'old'::text
          FROM public._tenant_ops_weekly_metrics_raw(p_week_start, p_week_end) r;
    END IF;
    RETURN;
  END IF;

  IF p_week_end < v_today THEN
    RETURN QUERY
      SELECT m.total_active_tenants, m.paying_tenants, m.non_paying_tenants, m.new_tenants_added,
             m.payment_rate_pct, m.self_payment_tenants, m.dormant_20_plus_count,
             m.landlord_not_paid_count, 'amclock'::text
        FROM public.tenant_ops_weekly_metrics_amclock m WHERE m.week_start = p_week_start;
    IF FOUND THEN
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
    SELECT r.total_active_tenants, r.paying_tenants, r.non_paying_tenants, r.new_tenants_added,
           r.payment_rate_pct, r.self_payment_tenants, r.dormant_20_plus_count,
           r.landlord_not_paid_count, 'amclock'::text
      FROM public._tenant_ops_weekly_metrics_raw_amclock(p_week_start, p_week_end) r;
END;
$function$;

-- 7. Weekly Performance, same JSON as get_tenant_ops_weekly_performance plus landlord_not_paid_count,
--    the way each week was counted, and a flag on the first week counted the new way.
CREATE OR REPLACE FUNCTION public.get_tenant_ops_weekly_performance_amclock(p_anchor date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_anchor date := COALESCE(p_anchor, v_today);
  v_first date := public._tenant_ops_weekly_amclock_first_week();
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

  SELECT period_start, period_end INTO v_cur_start, v_cur_end FROM public.tppo_period_bounds('week', v_anchor);
  v_prev_start := v_cur_start - 7;
  v_prev_end := v_cur_end - 7;

  SELECT * INTO v_cur  FROM public._tenant_ops_weekly_amclock_week(v_cur_start, v_cur_end);
  SELECT * INTO v_prev FROM public._tenant_ops_weekly_amclock_week(v_prev_start, v_prev_end);

  RETURN jsonb_build_object(
    'week_start', v_cur_start,
    'week_end', v_cur_end,
    'is_current_week_open', (v_cur_end >= v_today),
    'counting', v_cur.counting,
    'first_amclock_week', v_first,
    'counting_changed_this_week', (v_cur_start = v_first),
    'current', jsonb_build_object(
      'total_active_tenants', v_cur.total_active_tenants,
      'paying_tenants', v_cur.paying_tenants,
      'non_paying_tenants', v_cur.non_paying_tenants,
      'new_tenants_added', v_cur.new_tenants_added,
      'payment_rate_pct', v_cur.payment_rate_pct,
      'self_payment_tenants', v_cur.self_payment_tenants,
      'dormant_20_plus_count', v_cur.dormant_20_plus_count,
      'landlord_not_paid_count', v_cur.landlord_not_paid_count
    ),
    'previous', jsonb_build_object(
      'week_start', v_prev_start,
      'week_end', v_prev_end,
      'counting', v_prev.counting,
      'total_active_tenants', v_prev.total_active_tenants,
      'paying_tenants', v_prev.paying_tenants,
      'non_paying_tenants', v_prev.non_paying_tenants,
      'new_tenants_added', v_prev.new_tenants_added,
      'payment_rate_pct', v_prev.payment_rate_pct,
      'self_payment_tenants', v_prev.self_payment_tenants,
      'dormant_20_plus_count', v_prev.dormant_20_plus_count,
      'landlord_not_paid_count', v_prev.landlord_not_paid_count
    ),
    'delta', jsonb_build_object(
      'total_active_tenants', v_cur.total_active_tenants - v_prev.total_active_tenants,
      'paying_tenants', v_cur.paying_tenants - v_prev.paying_tenants,
      'non_paying_tenants', v_cur.non_paying_tenants - v_prev.non_paying_tenants,
      'new_tenants_added', v_cur.new_tenants_added - v_prev.new_tenants_added,
      'payment_rate_pct', round(v_cur.payment_rate_pct - v_prev.payment_rate_pct, 1),
      'self_payment_tenants', v_cur.self_payment_tenants - v_prev.self_payment_tenants,
      'self_payment_increase_pct', CASE
        WHEN v_prev.self_payment_tenants > 0
          THEN round((v_cur.self_payment_tenants - v_prev.self_payment_tenants)::numeric
                      / v_prev.self_payment_tenants::numeric * 100, 1)
        ELSE NULL
      END,
      'dormant_20_plus_count', v_cur.dormant_20_plus_count - v_prev.dormant_20_plus_count,
      'landlord_not_paid_count', v_cur.landlord_not_paid_count - v_prev.landlord_not_paid_count
    )
  );
END;
$function$;

-- 8. History: old frozen weeks as recorded, then the new frozen weeks. The first new-way week is flagged.
CREATE OR REPLACE FUNCTION public.get_tenant_ops_weekly_history_amclock(p_limit integer DEFAULT 12)
RETURNS TABLE (
  week_start              date,
  week_end                date,
  total_active_tenants    integer,
  paying_tenants          integer,
  non_paying_tenants      integer,
  new_tenants_added       integer,
  payment_rate_pct        numeric,
  captured_at             timestamptz,
  self_payment_tenants    integer,
  dormant_20_plus_count   integer,
  landlord_not_paid_count integer,
  counting                text,
  counting_changed        boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT h.*
    FROM (
      SELECT o.week_start, o.week_end, o.total_active_tenants, o.paying_tenants, o.non_paying_tenants,
             o.new_tenants_added, o.payment_rate_pct, o.captured_at, o.self_payment_tenants,
             o.dormant_20_plus_count, NULL::integer AS landlord_not_paid_count,
             'old'::text AS counting, false AS counting_changed
        FROM public.tenant_ops_weekly_metrics o
       WHERE o.week_start < public._tenant_ops_weekly_amclock_first_week()
      UNION ALL
      SELECT n.week_start, n.week_end, n.total_active_tenants, n.paying_tenants, n.non_paying_tenants,
             n.new_tenants_added, n.payment_rate_pct, n.captured_at, n.self_payment_tenants,
             n.dormant_20_plus_count, n.landlord_not_paid_count,
             'amclock'::text, (n.week_start = public._tenant_ops_weekly_amclock_first_week())
        FROM public.tenant_ops_weekly_metrics_amclock n
       WHERE n.week_start >= public._tenant_ops_weekly_amclock_first_week()
    ) h
   WHERE auth.uid() IS NOT NULL
     AND (
       public.is_ops_role(auth.uid())
       OR public.has_role(auth.uid(), 'manager')
       OR public.has_role(auth.uid(), 'super_admin')
       OR public.has_role(auth.uid(), 'cto')
       OR public.has_role(auth.uid(), 'ceo')
       OR public.has_role(auth.uid(), 'coo')
     )
   ORDER BY h.week_start DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 104);
$function$;

-- 9. Grants. Internal helpers and the pin functions are not callable from the API.
REVOKE ALL ON FUNCTION public._tenant_ops_weekly_amclock_first_week() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._tenant_ops_weekly_amclock_plans(date, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._tenant_ops_weekly_metrics_raw_amclock(date, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._tenant_ops_weekly_amclock_week(date, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.pin_tenant_ops_weekly_metrics_amclock(date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.pin_tenant_ops_weekly_metrics_amclock_catchup(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_tenant_ops_weekly_performance_amclock(date) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.get_tenant_ops_weekly_history_amclock(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_tenant_ops_weekly_performance_amclock(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_tenant_ops_weekly_history_amclock(integer) TO authenticated;

-- 10. A new cron job freezes each closed week the new way, at the same time as the existing job.
DO $cron$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.schedule(
      'pin-tenant-ops-weekly-metrics-amclock-eat-wed',
      '10 21 * * 2',
      'SELECT public.pin_tenant_ops_weekly_metrics_amclock_catchup(2);'
    );
  END IF;
END
$cron$;
