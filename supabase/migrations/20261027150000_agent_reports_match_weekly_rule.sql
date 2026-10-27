-- One "expected" for every agent report: the daily bill, plus a normal day for expired tenants whose
-- billing stopped.
--
-- 20261027100000 made the weekly posting rule count expired tenants whose daily billing stopped (their
-- unpaid bills already cover what they owe) as a normal week. The agent's dashboard still read the raw
-- daily bill (agent_expected_day_plans) everywhere else, so the daily target, the 7-day card, the
-- weekly PDF and the performance calendar disagreed with the Weekly Performance page
-- (27 Oct: Shafeeq Ssenabulya's daily target showed 488,700 while 11 such tenants owed 140,553 a day).
-- Decided with Pius 2026-10-27: the agent's daily and weekly reports must match the weekly rule.
--
-- _agent_expected_effective(agents, from, to) returns one row per (day, agent, plan):
--   the pinned bill for that day, or, for a qualifying expired tenant, a normal day
--   (daily_repayment) when that is larger, counted day by day from the later of the rule week's
--   Thursday, rent_plan_billable_from and the expired-plan billing go-live, and stopping once the
--   week's days add up to what the tenant owed at the start of that week.
-- Qualifying (same as 20261027100000): expired before the rule week starts, repaying, daily, still
-- owes, not paused or not_paying, billed at least once before; owner = assigned_agent_id else agent_id.
-- "Owed at the start of the week" = total_repayment - amount_repaid + every non-reversed collection on
-- the plan since that Thursday.
--
-- Everything that shows an agent an expected amount now reads it:
--   _agent_weekly_posting_compute / _agent_weekly_plan_lines  (the rule and the Weekly Performance page)
--   v_agent_daily_eligibility (today/yesterday)               (every daily target on the dashboard)
--   agent_expected_week__impl                                  (the "this week" card)
--   get_my_expected_days                                       (new: weekly PDF and performance calendar)
-- Tenants' bills, balances and the arrears ledger are untouched.

CREATE OR REPLACE FUNCTION public._agent_expected_effective__impl(p_agent_ids uuid[], p_from date, p_to date)
RETURNS TABLE(day date, agent_id uuid, rent_request_id uuid, tenant_id uuid, expected_ugx numeric, is_normal_day boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH weeks AS (
    SELECT DISTINCT public._agent_rule_week_start(g::date) AS lo
    FROM generate_series(p_from, p_to, interval '1 day') g
  ), cand AS (
    SELECT wk.lo,
           COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
           rr.id AS rent_request_id,
           rr.tenant_id,
           rr.daily_repayment AS daily,
           GREATEST(wk.lo, public.rent_plan_billable_from(rr.id), public.agent_arrears_billing_go_live()) AS s0,
           GREATEST(COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0)
                    + COALESCE((SELECT sum(ac.amount) FROM public.agent_collections ac
                                WHERE ac.rent_request_id = rr.id AND ac.reversed_at IS NULL AND ac.amount > 0
                                  AND ac.created_at >= (wk.lo::timestamp AT TIME ZONE 'Africa/Kampala')), 0),
                    0) AS owed_at_start
    FROM weeks wk
    CROSS JOIN public.rent_requests rr
    WHERE rr.status = 'repaying'
      AND COALESCE(rr.agent_payment_status, 'paying') <> 'not_paying'
      AND lower(COALESCE(rr.repayment_frequency, 'daily')) <> 'weekly'
      AND COALESCE(rr.daily_repayment, 0) > 0
      AND COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0) > 0
      AND COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date)
            + COALESCE(rr.duration_days, 0) - 1 < wk.lo
      AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL
      AND (p_agent_ids IS NULL OR COALESCE(rr.assigned_agent_id, rr.agent_id) = ANY (p_agent_ids))
      AND EXISTS (SELECT 1 FROM public.agent_expected_day_plans e0 WHERE e0.rent_request_id = rr.id)
      AND NOT EXISTS (
        SELECT 1 FROM public.rent_repayment_pauses z
        WHERE z.rent_request_id = rr.id AND z.status = 'active' AND z.resumed_at IS NULL
          AND (z.resume_on IS NULL OR z.resume_on >= LEAST(wk.lo + 6, p_to)))
  ), normal_days AS (
    SELECT c.agent_id, c.rent_request_id, c.tenant_id, g::date AS day,
           LEAST(c.daily, GREATEST(c.owed_at_start - c.daily * (row_number() OVER (PARTITION BY c.lo, c.rent_request_id ORDER BY g) - 1), 0)) AS amount
    FROM cand c
    CROSS JOIN LATERAL generate_series(c.s0, LEAST(c.lo + 6, p_to), interval '1 day') g
  ), pins AS (
    SELECT e.day, e.agent_id, e.rent_request_id, e.tenant_id, e.expected_ugx
    FROM public.agent_expected_day_plans e
    WHERE e.day BETWEEN p_from AND p_to
      AND e.agent_id IS NOT NULL
      AND e.expected_ugx > 0
      AND (p_agent_ids IS NULL OR e.agent_id = ANY (p_agent_ids))
  )
  SELECT COALESCE(p.day, n.day),
         COALESCE(p.agent_id, n.agent_id),
         COALESCE(p.rent_request_id, n.rent_request_id),
         COALESCE(p.tenant_id, n.tenant_id),
         GREATEST(COALESCE(p.expected_ugx, 0), COALESCE(n.amount, 0)),
         COALESCE(n.amount, 0) > COALESCE(p.expected_ugx, 0)
  FROM pins p
  FULL JOIN (SELECT * FROM normal_days WHERE day >= p_from AND amount > 0) n
    ON n.day = p.day AND n.rent_request_id = p.rent_request_id AND n.agent_id = p.agent_id;
$function$;

-- The weekly rule: due per plan = sum of _agent_expected_effective over the week (was: pins, plus the
-- normal-week lift worked out separately). Collected/finished rules unchanged (20261026090000).
CREATE OR REPLACE FUNCTION public._agent_weekly_posting_compute(p_week_start date, p_agent_ids uuid[] DEFAULT NULL)
RETURNS SETOF public.agent_weekly_posting_eligibility
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH s AS (
    SELECT * FROM public.agent_posting_rule_settings WHERE id
  ), w AS (
    SELECT p_week_start AS lo, p_week_start + 6 AS hi
  ), eff AS (
    SELECT x.agent_id, x.rent_request_id,
           (array_agg(x.tenant_id) FILTER (WHERE x.tenant_id IS NOT NULL))[1] AS tenant_id,
           sum(x.expected_ugx) AS due,
           bool_or(NOT x.is_normal_day) AS has_pin
    FROM w, public._agent_expected_effective__impl(p_agent_ids, w.lo, w.hi) x
    GROUP BY x.agent_id, x.rent_request_id
  ), bill AS (
    SELECT f.agent_id, f.rent_request_id, f.tenant_id, f.due,
           COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date)
             + COALESCE(rr.duration_days, 0) - 1 < w.lo AS expired,
           -- Finished during the week (20261026090000): completed, billed this week, never billed after.
           (f.has_pin AND rr.status = 'completed'
             AND NOT EXISTS (SELECT 1 FROM public.agent_expected_day_plans x
                             WHERE x.rent_request_id = f.rent_request_id AND x.day > w.hi)) AS finished,
           COALESCE(rr.total_repayment, 0) AS total_repayment,
           COALESCE(rr.amount_repaid, 0) AS amount_repaid
    FROM eff f
    JOIN public.rent_requests rr ON rr.id = f.rent_request_id
    CROSS JOIN w
  ), per_plan AS (
    SELECT b.agent_id, b.expired, b.due,
           CASE WHEN b.finished
                THEN LEAST(COALESCE(c.paid, 0),
                           GREATEST(b.due, GREATEST(b.total_repayment - (b.amount_repaid - COALESCE(c.paid, 0)), 0)))
                ELSE LEAST(COALESCE(c.paid, 0), b.due)
           END AS collected
    FROM bill b
    CROSS JOIN w
    LEFT JOIN LATERAL (
      -- Same matching as snapshot_agent_daily_eligibility: by plan, or by tenant when the
      -- collection carries no plan id.
      SELECT sum(ac.amount) AS paid
      FROM public.agent_collections ac
      WHERE ac.reversed_at IS NULL
        AND ac.amount > 0
        AND ac.agent_id = b.agent_id
        AND (ac.rent_request_id = b.rent_request_id
             OR (ac.rent_request_id IS NULL AND ac.tenant_id IS NOT NULL AND ac.tenant_id = b.tenant_id))
        AND ac.created_at >= (w.lo::timestamp AT TIME ZONE 'Africa/Kampala')
        AND ac.created_at <  ((w.hi + 1)::timestamp AT TIME ZONE 'Africa/Kampala')
    ) c ON true
    WHERE b.due > 0
  ), agg AS (
    SELECT p.agent_id,
           COALESCE(sum(p.due)       FILTER (WHERE NOT p.expired), 0) AS in_due,
           COALESCE(sum(p.collected) FILTER (WHERE NOT p.expired), 0) AS in_got,
           count(*) FILTER (WHERE NOT p.expired)::int                 AS in_plans,
           COALESCE(sum(p.due)       FILTER (WHERE p.expired), 0)     AS ex_due,
           COALESCE(sum(p.collected) FILTER (WHERE p.expired), 0)     AS ex_got,
           count(*) FILTER (WHERE p.expired)::int                     AS ex_plans
    FROM per_plan p
    GROUP BY p.agent_id
  ), judged AS (
    SELECT a.*,
           CASE WHEN a.in_due > 0 AND a.ex_due > 0 THEN 'mixed'
                WHEN a.in_due > 0 THEN 'in_window_only'
                WHEN a.ex_due > 0 THEN 'all_expired'
                ELSE 'none' END AS book,
           CASE WHEN a.in_due > 0 THEN round(a.in_got / a.in_due, 4) END AS in_pct,
           CASE WHEN a.ex_due > 0 THEN round(a.ex_got / a.ex_due, 4) END AS ex_pct
    FROM agg a
  ), ruled AS (
    SELECT j.*,
           CASE WHEN j.in_due > 0 THEN s.in_window_required_pct END AS in_req,
           CASE j.book WHEN 'mixed' THEN s.expired_required_pct
                       WHEN 'all_expired' THEN s.all_expired_required_pct END AS ex_req
    FROM judged j CROSS JOIN s
  )
  SELECT r.agent_id, w.lo, w.hi,
         r.in_due, r.in_got, r.in_plans,
         r.ex_due, r.ex_got, r.ex_plans,
         r.book, r.in_pct, r.ex_pct, r.in_req, r.ex_req,
         -- Compared on amounts, not on rounded percentages.
         (r.in_req IS NULL OR r.in_got >= r.in_req * r.in_due)
           AND (r.ex_req IS NULL OR r.ex_got >= r.ex_req * r.ex_due) AS passes,
         NULLIF(concat_ws(' ',
           CASE WHEN r.in_req IS NOT NULL AND r.in_got < r.in_req * r.in_due THEN
             format('Last week (%s to %s) you collected %s%% of what your current Rent Plans were due (UGX %s of UGX %s). You need %s%%.',
                    to_char(w.lo, 'FMDD Mon'), to_char(w.hi, 'FMDD Mon'),
                    to_char(floor(r.in_pct * 1000) / 10, 'FM990.0'),
                    to_char(r.in_got, 'FM999,999,999,990'), to_char(r.in_due, 'FM999,999,999,990'),
                    to_char(r.in_req * 100, 'FM990'))
           END,
           CASE WHEN r.ex_req IS NOT NULL AND r.ex_got < r.ex_req * r.ex_due THEN
             -- When the current-plans sentence is already there, don't repeat "Last week (...)".
             format('%s %s%% of what %s were due (UGX %s of UGX %s). You need %s%%.',
                    CASE WHEN r.in_req IS NOT NULL AND r.in_got < r.in_req * r.in_due
                         THEN 'On your expired Rent Plans you collected'
                         ELSE format('Last week (%s to %s) you collected', to_char(w.lo, 'FMDD Mon'), to_char(w.hi, 'FMDD Mon'))
                    END,
                    to_char(floor(r.ex_pct * 1000) / 10, 'FM990.0'),
                    CASE WHEN r.in_req IS NOT NULL AND r.in_got < r.in_req * r.in_due
                         THEN 'they' ELSE 'your expired Rent Plans' END,
                    to_char(r.ex_got, 'FM999,999,999,990'), to_char(r.ex_due, 'FM999,999,999,990'),
                    to_char(r.ex_req * 100, 'FM990'))
           END
         ), '') AS reason,
         now()
  FROM ruled r CROSS JOIN w;
$function$;

CREATE OR REPLACE FUNCTION public._agent_weekly_plan_lines(p_agent_id uuid, p_week_start date, p_through date)
RETURNS TABLE(
  rent_request_id uuid, tenant_id uuid, expired boolean,
  due numeric, collected numeric, paid_raw numeric, billed_days integer, last_day_due numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH w AS (
    SELECT p_week_start AS lo, LEAST(p_week_start + 6, p_through) AS hi
  ), eff AS (
    SELECT x.rent_request_id,
           (array_agg(x.tenant_id) FILTER (WHERE x.tenant_id IS NOT NULL))[1] AS tenant_id,
           sum(x.expected_ugx) AS due,
           count(DISTINCT x.day) FILTER (WHERE NOT x.is_normal_day)::int AS billed_days,
           COALESCE(sum(x.expected_ugx) FILTER (WHERE x.day = w.hi), 0) AS last_day_due,
           bool_or(NOT x.is_normal_day) AS has_pin
    FROM w, public._agent_expected_effective__impl(ARRAY[p_agent_id], w.lo, w.hi) x
    WHERE x.agent_id = p_agent_id
    GROUP BY x.rent_request_id, w.hi
  ), bill AS (
    SELECT f.*,
           COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date)
             + COALESCE(rr.duration_days, 0) - 1 < w.lo AS expired,
           -- Finished during the week (20261026090000), measured up to p_through.
           (f.has_pin AND rr.status = 'completed'
             AND NOT EXISTS (SELECT 1 FROM public.agent_expected_day_plans x
                             WHERE x.rent_request_id = f.rent_request_id AND x.day > w.hi)) AS finished,
           COALESCE(rr.total_repayment, 0) AS total_repayment,
           COALESCE(rr.amount_repaid, 0) AS amount_repaid
    FROM eff f
    JOIN public.rent_requests rr ON rr.id = f.rent_request_id
    CROSS JOIN w
  )
  SELECT b.rent_request_id, b.tenant_id, b.expired, b.due,
         CASE WHEN b.finished
              THEN LEAST(COALESCE(c.paid, 0),
                         GREATEST(b.due, GREATEST(b.total_repayment - (b.amount_repaid - COALESCE(c.paid, 0)), 0)))
              ELSE LEAST(COALESCE(c.paid, 0), b.due)
         END,
         COALESCE(c.paid, 0),
         b.billed_days,
         -- A finished plan won't be billed again: nothing to project for the days left.
         CASE WHEN b.finished THEN 0 ELSE b.last_day_due END
  FROM bill b
  CROSS JOIN w
  LEFT JOIN LATERAL (
    SELECT sum(ac.amount) AS paid
    FROM public.agent_collections ac
    WHERE ac.reversed_at IS NULL
      AND ac.amount > 0
      AND ac.agent_id = p_agent_id
      AND (ac.rent_request_id = b.rent_request_id
           OR (ac.rent_request_id IS NULL AND ac.tenant_id IS NOT NULL AND ac.tenant_id = b.tenant_id))
      AND ac.created_at >= (w.lo::timestamp AT TIME ZONE 'Africa/Kampala')
      AND ac.created_at <  ((w.hi + 1)::timestamp AT TIME ZONE 'Africa/Kampala')
  ) c ON true
  WHERE b.due > 0;
$function$;

-- Callable form for the daily view, which the agent's browser also reads directly (views run their
-- functions with the reader's permissions). A direct call from a signed-in non-staff user only ever
-- returns that user's own agents and their network; called from inside another function (the RPCs,
-- the snapshot job) it returns what was asked.
CREATE OR REPLACE FUNCTION public._agent_expected_effective(p_agent_ids uuid[], p_from date, p_to date)
RETURNS TABLE(day date, agent_id uuid, rent_request_id uuid, tenant_id uuid, expected_ugx numeric, is_normal_day boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ids uuid[] := p_agent_ids;
BEGIN
  IF public._direct_client_call() AND NOT public.can_view_staff_reports(auth.uid()) THEN
    IF auth.uid() IS NULL THEN
      RETURN;
    END IF;
    SELECT array_agg(a.id) INTO v_ids
    FROM (SELECT auth.uid() AS id UNION SELECT public.agent_wallet_network_ids(auth.uid())) a
    WHERE p_agent_ids IS NULL OR a.id = ANY (p_agent_ids);
  END IF;
  RETURN QUERY SELECT * FROM public._agent_expected_effective__impl(v_ids, p_from, p_to);
END
$function$;

-- The agent's expected amount per tenant per day: the weekly PDF and the performance calendar.
CREATE OR REPLACE FUNCTION public.get_my_expected_days(p_from date, p_to date, p_agent_id uuid DEFAULT NULL)
RETURNS TABLE(day date, rent_request_id uuid, tenant_id uuid, expected_ugx numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_agent uuid := COALESCE(p_agent_id, auth.uid());
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING errcode = '42501';
  END IF;
  IF v_agent IS DISTINCT FROM v_uid
     AND NOT public.can_view_staff_reports(v_uid)
     AND v_agent NOT IN (SELECT public.agent_wallet_network_ids(v_uid)) THEN
    RAISE EXCEPTION 'not authorized' USING errcode = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 400 THEN
    RAISE EXCEPTION 'invalid range' USING errcode = '22023';
  END IF;
  RETURN QUERY
    SELECT x.day, x.rent_request_id, x.tenant_id, x.expected_ugx
    FROM public._agent_expected_effective__impl(ARRAY[v_agent], p_from, p_to) x
    WHERE x.agent_id = v_agent;
END
$function$;

-- Daily view: today's and yesterday's expected come from the same source (only the pin_days source changes).
CREATE OR REPLACE VIEW public.v_agent_daily_eligibility AS
SELECT agent_id,
    active_count,
    expected_daily,
    paid_today,
    paid_yesterday,
    today_pct,
    yesterday_pct,
    effective_pct,
    raw_today_pct,
    raw_yesterday_pct,
    tenants_due,
    tenants_paid_today,
    tenants_paid_yesterday,
    coverage_today,
    coverage_yesterday,
    effective_coverage,
    weekly_plan_count,
    weekly_lapsed_count,
    weekly_expected_week
   FROM ( WITH day_start AS (
                 SELECT ((((now() AT TIME ZONE 'Africa/Kampala'::text))::date)::timestamp without time zone AT TIME ZONE 'Africa/Kampala'::text) AS ts,
                    ((now() AT TIME ZONE 'Africa/Kampala'::text))::date AS d_today,
                    (((now() AT TIME ZONE 'Africa/Kampala'::text))::date - 1) AS d_yesterday,
                    (((((now() AT TIME ZONE 'Africa/Kampala'::text))::date - 6))::timestamp without time zone AT TIME ZONE 'Africa/Kampala'::text) AS week_ts
                ), pin_days AS (
                 SELECT ep.rent_request_id,
                    COALESCE(sum(ep.expected_ugx) FILTER (WHERE (ep.day = ds.d_today)), (0)::numeric) AS pin_today,
                    COALESCE(sum(ep.expected_ugx) FILTER (WHERE (ep.day = ds.d_yesterday)), (0)::numeric) AS pin_yesterday
                   FROM (day_start ds
                     CROSS JOIN LATERAL public._agent_expected_effective(NULL::uuid[], ds.d_yesterday, ds.d_today) ep(day, agent_id, rent_request_id, tenant_id, expected_ugx, is_normal_day))
                  GROUP BY ep.rent_request_id
                ), stale_debt AS (
                 SELECT COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
                    sum(GREATEST((COALESCE(rr.total_repayment, (0)::numeric) - COALESCE(rr.amount_repaid, (0)::numeric)), (0)::numeric)) AS past_cycle_owed
                   FROM (rent_requests rr
                     CROSS JOIN day_start ds)
                  WHERE ((rr.status = ANY (ARRAY['funded'::text, 'repaying'::text])) AND (((COALESCE(rr.repayment_starts_on, ((rr.funded_at AT TIME ZONE 'Africa/Kampala'::text))::date) + COALESCE(rr.duration_days, 0)) - 1) < ds.d_today) AND ((COALESCE(rr.total_repayment, (0)::numeric) - COALESCE(rr.amount_repaid, (0)::numeric)) > (0)::numeric))
                  GROUP BY COALESCE(rr.assigned_agent_id, rr.agent_id)
                ), all_rents AS (
                 SELECT rr.agent_id,
                    rr.status,
                    rr.id AS rent_request_id,
                    rr.tenant_id,
                    rr.daily_repayment,
                    rr.amount_repaid,
                    rr.total_repayment,
                    rr.funded_at,
                    COALESCE(rr.repayment_starts_on, ((rr.funded_at AT TIME ZONE 'Africa/Kampala'::text))::date) AS starts_on,
                        CASE
                            WHEN rr.repayment_frequency_locked THEN (lower(COALESCE(rr.repayment_frequency, 'daily'::text)) = 'weekly'::text)
                            ELSE ((lower(COALESCE(rr.repayment_frequency, 'daily'::text)) = 'weekly'::text) OR rent_request_is_weekly_shape(rr.duration_days, rr.registration_type))
                        END AS is_weekly
                   FROM rent_requests rr
                  WHERE (((rr.status = ANY (ARRAY['funded'::text, 'repaying'::text])) OR ((rr.status = 'completed'::text) AND (EXISTS ( SELECT 1
                           FROM agent_collections ac0
                          WHERE ((ac0.reversed_at IS NULL) AND (ac0.amount > (0)::numeric) AND (ac0.created_at >= ((((now() AT TIME ZONE 'Africa/Kampala'::text))::date)::timestamp without time zone AT TIME ZONE 'Africa/Kampala'::text)) AND ((ac0.rent_request_id = rr.id) OR ((ac0.rent_request_id IS NULL) AND (ac0.tenant_id IS NOT NULL) AND (ac0.tenant_id = rr.tenant_id)))))))) AND (COALESCE(rr.agent_payment_status, 'paying'::text) <> 'not_paying'::text))
                ), week_paid AS (
                 SELECT ar.rent_request_id
                   FROM (all_rents ar
                     CROSS JOIN day_start ds)
                  WHERE (ar.is_weekly AND (EXISTS ( SELECT 1
                           FROM agent_collections ac
                          WHERE ((ac.created_at >= ds.week_ts) AND (ac.amount > (0)::numeric) AND ((ac.rent_request_id = ar.rent_request_id) OR ((ac.rent_request_id IS NULL) AND (ac.tenant_id IS NOT NULL) AND (ac.tenant_id = ar.tenant_id)))))))
                ), active_rents AS (
                 SELECT ar.agent_id,
                    ar.status,
                    ar.rent_request_id,
                    ar.tenant_id,
                    ar.daily_repayment,
                    ar.amount_repaid,
                    ar.total_repayment,
                    ar.funded_at,
                    ar.starts_on,
                    ar.is_weekly,
                    (ar.is_weekly AND (ar.starts_on IS NOT NULL) AND ((ar.starts_on + 7) <= ds.d_today) AND (wp.rent_request_id IS NULL)) AS weekly_lapsed
                   FROM ((all_rents ar
                     CROSS JOIN day_start ds)
                     LEFT JOIN week_paid wp ON ((wp.rent_request_id = ar.rent_request_id)))
                ), prior_paid AS (
                 SELECT ac.rent_request_id,
                    sum(ac.amount) AS paid_before_today
                   FROM (agent_collections ac
                     CROSS JOIN day_start ds)
                  WHERE ((ac.rent_request_id IS NOT NULL) AND (ac.created_at < ds.ts))
                  GROUP BY ac.rent_request_id
                ), paused AS (
                 SELECT DISTINCT p.rent_request_id
                   FROM rent_repayment_pauses p
                  WHERE ((p.status = 'active'::text) AND (p.resumed_at IS NULL) AND ((p.resume_on IS NULL) OR (p.resume_on >= ((now() AT TIME ZONE 'Africa/Kampala'::text))::date)))
                ), reversal_marks AS (
                 SELECT r.rent_request_id,
                    r.created_at AS reversed_at
                   FROM agent_tenant_float_reversals r
                  WHERE (r.rent_request_id IS NOT NULL)
                UNION ALL
                 SELECT arr.rent_request_id,
                    COALESCE(arr.cfo_decision_at, arr.updated_at, arr.created_at) AS "coalesce"
                   FROM agent_allocation_return_requests arr
                  WHERE ((arr.status = 'approved'::text) AND (arr.rent_request_id IS NOT NULL))
                ), reversal_latest AS (
                 SELECT rm.rent_request_id,
                    max(rm.reversed_at) AS reversed_at
                   FROM reversal_marks rm
                  GROUP BY rm.rent_request_id
                ), reversed AS (
                 SELECT rl.rent_request_id
                   FROM reversal_latest rl
                  WHERE (NOT (EXISTS ( SELECT 1
                           FROM agent_landlord_float_allocations al
                          WHERE ((al.rent_request_id = rl.rent_request_id) AND (al.paid_out_amount > (0)::numeric) AND (COALESCE(al.updated_at, al.created_at) > rl.reversed_at)))))
                ), landlord_settled AS (
                 SELECT DISTINCT a_1.rent_request_id
                   FROM agent_landlord_float_allocations a_1
                  WHERE ((a_1.rent_request_id IS NOT NULL) AND (a_1.paid_out_amount > (0)::numeric))
                ), alloc_activity AS (
                 SELECT a_1.rent_request_id,
                    max(GREATEST(a_1.created_at, COALESCE(a_1.updated_at, a_1.created_at))) AS last_change
                   FROM agent_landlord_float_allocations a_1
                  WHERE (a_1.rent_request_id IS NOT NULL)
                  GROUP BY a_1.rent_request_id
                ), live_rents AS (
                 SELECT ar.agent_id,
                    ar.status,
                    ar.rent_request_id,
                    ar.tenant_id,
                    ar.daily_repayment,
                    ar.amount_repaid,
                    ar.total_repayment,
                    ar.funded_at,
                    ar.starts_on,
                    ar.is_weekly,
                    ar.weekly_lapsed
                   FROM (((((((active_rents ar
                     CROSS JOIN day_start ds)
                     LEFT JOIN prior_paid pp ON ((pp.rent_request_id = ar.rent_request_id)))
                     LEFT JOIN alloc_activity aa ON ((aa.rent_request_id = ar.rent_request_id)))
                     LEFT JOIN reversed rv ON ((rv.rent_request_id = ar.rent_request_id)))
                     LEFT JOIN paused pz ON ((pz.rent_request_id = ar.rent_request_id)))
                     LEFT JOIN landlord_settled ls ON ((ls.rent_request_id = ar.rent_request_id)))
                     LEFT JOIN LATERAL ( SELECT count(*) AS open_allocs
                           FROM agent_landlord_float_allocations oa_1
                          WHERE ((oa_1.rent_request_id = ar.rent_request_id) AND (oa_1.status = ANY (ARRAY['open'::text, 'partially_paid'::text, 'return_pending'::text])))) oa ON (true))
                  WHERE (((rv.rent_request_id IS NULL) OR (COALESCE(pp.paid_before_today, (0)::numeric) > (0)::numeric)) AND (pz.rent_request_id IS NULL) AND (((COALESCE(ar.total_repayment, (0)::numeric) - COALESCE(ar.amount_repaid, (0)::numeric)) > (0)::numeric) OR (EXISTS ( SELECT 1
                           FROM agent_collections ac2
                          WHERE ((ac2.amount > (0)::numeric) AND (ac2.created_at >= ds.ts) AND ((ac2.rent_request_id = ar.rent_request_id) OR ((ac2.rent_request_id IS NULL) AND (ac2.tenant_id IS NOT NULL) AND (ac2.tenant_id = ar.tenant_id))))))) AND ((COALESCE(pp.paid_before_today, (0)::numeric) > (0)::numeric) OR (((ar.funded_at IS NULL) OR (ar.funded_at < ds.ts)) AND ((aa.last_change IS NULL) OR (aa.last_change < ds.ts)) AND ((ls.rent_request_id IS NOT NULL) OR (COALESCE(oa.open_allocs, (0)::bigint) = 0)))))
                ), weekly_stats AS (
                 SELECT lr.agent_id,
                    (count(*))::integer AS weekly_plan_count,
                    (count(*) FILTER (WHERE lr.weekly_lapsed))::integer AS weekly_lapsed_count,
                    COALESCE(sum((COALESCE(lr.daily_repayment, (0)::numeric) * (7)::numeric)), (0)::numeric) AS weekly_expected_week
                   FROM live_rents lr
                  WHERE lr.is_weekly
                  GROUP BY lr.agent_id
                ), eligible_rents AS (
                 SELECT lr.agent_id,
                    lr.status,
                    lr.rent_request_id,
                    lr.tenant_id,
                    (pd.rent_request_id IS NOT NULL) AS was_billed,
                    COALESCE(lr.daily_repayment, (0)::numeric) AS daily_repayment,
                        CASE
                            WHEN (pd.rent_request_id IS NULL) THEN COALESCE(
                            CASE
                                WHEN ((pd.rent_request_id IS NULL) AND (NOT (EXISTS ( SELECT 1
                                   FROM agent_expected_day_plans xb
                                  WHERE ((xb.agent_id = lr.agent_id) AND (xb.day >= (((now() AT TIME ZONE 'Africa/Kampala'::text))::date - 1)))))) AND ((NOT lr.is_weekly) OR lr.weekly_lapsed) AND (COALESCE(lr.daily_repayment, (0)::numeric) > (0)::numeric)) THEN LEAST(lr.daily_repayment, GREATEST((COALESCE(lr.total_repayment, (0)::numeric) - COALESCE(lr.amount_repaid, (0)::numeric)), (0)::numeric))
                                ELSE NULL::numeric
                            END, (0)::numeric)
                            WHEN (COALESCE(lr.daily_repayment, (0)::numeric) > (0)::numeric) THEN COALESCE(pd.pin_today, (0)::numeric)
                            ELSE COALESCE(pd.pin_today, (0)::numeric)
                        END AS due_today_amount,
                        CASE
                            WHEN (pd.rent_request_id IS NULL) THEN COALESCE(
                            CASE
                                WHEN ((pd.rent_request_id IS NULL) AND (NOT (EXISTS ( SELECT 1
                                   FROM agent_expected_day_plans xb
                                  WHERE ((xb.agent_id = lr.agent_id) AND (xb.day >= (((now() AT TIME ZONE 'Africa/Kampala'::text))::date - 1)))))) AND ((NOT lr.is_weekly) OR lr.weekly_lapsed) AND (COALESCE(lr.daily_repayment, (0)::numeric) > (0)::numeric)) THEN LEAST(lr.daily_repayment, GREATEST((COALESCE(lr.total_repayment, (0)::numeric) - COALESCE(lr.amount_repaid, (0)::numeric)), (0)::numeric))
                                ELSE NULL::numeric
                            END, (0)::numeric)
                            WHEN (COALESCE(lr.daily_repayment, (0)::numeric) > (0)::numeric) THEN COALESCE(pd.pin_yesterday, (0)::numeric)
                            ELSE COALESCE(pd.pin_yesterday, (0)::numeric)
                        END AS due_yesterday_amount,
                    ((COALESCE(pd.pin_today, (0)::numeric) > (0)::numeric) OR (COALESCE(
                        CASE
                            WHEN ((pd.rent_request_id IS NULL) AND (NOT (EXISTS ( SELECT 1
                               FROM agent_expected_day_plans xb
                              WHERE ((xb.agent_id = lr.agent_id) AND (xb.day >= (((now() AT TIME ZONE 'Africa/Kampala'::text))::date - 1)))))) AND ((NOT lr.is_weekly) OR lr.weekly_lapsed) AND (COALESCE(lr.daily_repayment, (0)::numeric) > (0)::numeric)) THEN LEAST(lr.daily_repayment, GREATEST((COALESCE(lr.total_repayment, (0)::numeric) - COALESCE(lr.amount_repaid, (0)::numeric)), (0)::numeric))
                            ELSE NULL::numeric
                        END, (0)::numeric) > (0)::numeric)) AS due_today,
                    ((COALESCE(pd.pin_yesterday, (0)::numeric) > (0)::numeric) OR (COALESCE(
                        CASE
                            WHEN ((pd.rent_request_id IS NULL) AND (NOT (EXISTS ( SELECT 1
                               FROM agent_expected_day_plans xb
                              WHERE ((xb.agent_id = lr.agent_id) AND (xb.day >= (((now() AT TIME ZONE 'Africa/Kampala'::text))::date - 1)))))) AND ((NOT lr.is_weekly) OR lr.weekly_lapsed) AND (COALESCE(lr.daily_repayment, (0)::numeric) > (0)::numeric)) THEN LEAST(lr.daily_repayment, GREATEST((COALESCE(lr.total_repayment, (0)::numeric) - COALESCE(lr.amount_repaid, (0)::numeric)), (0)::numeric))
                            ELSE NULL::numeric
                        END, (0)::numeric) > (0)::numeric)) AS due_yesterday
                   FROM (live_rents lr
                     LEFT JOIN pin_days pd ON ((pd.rent_request_id = lr.rent_request_id)))
                ), expected AS (
                 SELECT er.agent_id,
                    (count(*))::integer AS active_count,
                    COALESCE(sum(er.due_today_amount), (0)::numeric) AS expected_daily,
                    COALESCE(sum(er.due_yesterday_amount), (0)::numeric) AS expected_yesterday,
                    (count(*) FILTER (WHERE er.due_today))::integer AS due_today_count,
                    (count(*) FILTER (WHERE er.due_yesterday))::integer AS due_yesterday_count
                   FROM eligible_rents er
                  WHERE ((er.status = 'repaying'::text) OR er.was_billed)
                  GROUP BY er.agent_id
                ), agents AS (
                 SELECT expected.agent_id
                   FROM expected
                UNION
                 SELECT weekly_stats.agent_id
                   FROM weekly_stats
                ), collection_events AS (
                 SELECT ac.agent_id,
                    ac.rent_request_id,
                    ac.tenant_id,
                    ac.amount,
                    ((ac.created_at AT TIME ZONE 'Africa/Kampala'::text))::date AS day
                   FROM agent_collections ac
                  WHERE (ac.created_at >= (((((now() AT TIME ZONE 'Africa/Kampala'::text))::date - 1))::timestamp without time zone AT TIME ZONE 'Africa/Kampala'::text))
                ), matched AS (
                 SELECT er.agent_id,
                    er.rent_request_id,
                    er.due_today_amount,
                    er.due_yesterday_amount,
                    ce.day,
                    sum(ce.amount) AS tenant_paid
                   FROM (eligible_rents er
                     JOIN collection_events ce ON (((ce.agent_id = er.agent_id) AND ((ce.rent_request_id = er.rent_request_id) OR ((ce.rent_request_id IS NULL) AND (ce.tenant_id IS NOT NULL) AND (ce.tenant_id = er.tenant_id))))))
                  GROUP BY er.agent_id, er.rent_request_id, er.due_today_amount, er.due_yesterday_amount, ce.day
                ), per_day AS (
                 SELECT m.agent_id,
                    m.day,
                    sum(LEAST(m.tenant_paid, GREATEST(
                        CASE
                            WHEN (m.day = ( SELECT day_start.d_today
                               FROM day_start)) THEN m.due_today_amount
                            ELSE m.due_yesterday_amount
                        END, (0)::numeric))) AS capped_paid,
                    (count(*) FILTER (WHERE ((m.tenant_paid > (0)::numeric) AND (
                        CASE
                            WHEN (m.day = ( SELECT day_start.d_today
                               FROM day_start)) THEN m.due_today_amount
                            ELSE m.due_yesterday_amount
                        END > (0)::numeric))))::integer AS tenants_paid
                   FROM matched m
                  GROUP BY m.agent_id, m.day
                ), raw_collected AS (
                 SELECT m.agent_id,
                    sum(
                        CASE
                            WHEN (m.day = ( SELECT day_start.d_today
                               FROM day_start)) THEN m.tenant_paid
                            ELSE (0)::numeric
                        END) AS paid_today,
                    sum(
                        CASE
                            WHEN (m.day = ( SELECT day_start.d_yesterday
                               FROM day_start)) THEN m.tenant_paid
                            ELSE (0)::numeric
                        END) AS paid_yesterday
                   FROM matched m
                  GROUP BY m.agent_id
                ), coverage AS (
                 SELECT per_day.agent_id,
                    COALESCE(sum(per_day.capped_paid) FILTER (WHERE (per_day.day = ( SELECT day_start.d_today
                           FROM day_start))), (0)::numeric) AS capped_paid_today,
                    COALESCE(sum(per_day.capped_paid) FILTER (WHERE (per_day.day = ( SELECT day_start.d_yesterday
                           FROM day_start))), (0)::numeric) AS capped_paid_yesterday,
                    COALESCE(max(per_day.tenants_paid) FILTER (WHERE (per_day.day = ( SELECT day_start.d_today
                           FROM day_start))), 0) AS tenants_paid_today,
                    COALESCE(max(per_day.tenants_paid) FILTER (WHERE (per_day.day = ( SELECT day_start.d_yesterday
                           FROM day_start))), 0) AS tenants_paid_yesterday
                   FROM per_day
                  GROUP BY per_day.agent_id
                )
         SELECT a.agent_id,
            COALESCE(e.active_count, 0) AS active_count,
            COALESCE(e.expected_daily, (0)::numeric) AS expected_daily,
            COALESCE(rc.paid_today, (0)::numeric) AS paid_today,
            COALESCE(rc.paid_yesterday, (0)::numeric) AS paid_yesterday,
                CASE
                    WHEN (COALESCE(e.expected_daily, (0)::numeric) > (0)::numeric) THEN round((LEAST(COALESCE(cv.capped_paid_today, (0)::numeric), e.expected_daily) / e.expected_daily), 4)
                    ELSE
                    CASE
                        WHEN (COALESCE(sd.past_cycle_owed, (0)::numeric) > (0)::numeric) THEN (0)::numeric
                        ELSE (1)::numeric
                    END
                END AS today_pct,
                CASE
                    WHEN (COALESCE(e.expected_yesterday, (0)::numeric) > (0)::numeric) THEN round((LEAST(COALESCE(cv.capped_paid_yesterday, (0)::numeric), e.expected_yesterday) / e.expected_yesterday), 4)
                    ELSE
                    CASE
                        WHEN (COALESCE(sd.past_cycle_owed, (0)::numeric) > (0)::numeric) THEN (0)::numeric
                        ELSE (1)::numeric
                    END
                END AS yesterday_pct,
            GREATEST(
                CASE
                    WHEN (COALESCE(e.expected_daily, (0)::numeric) > (0)::numeric) THEN round((LEAST(COALESCE(cv.capped_paid_today, (0)::numeric), e.expected_daily) / e.expected_daily), 4)
                    ELSE
                    CASE
                        WHEN (COALESCE(sd.past_cycle_owed, (0)::numeric) > (0)::numeric) THEN (0)::numeric
                        ELSE (1)::numeric
                    END
                END,
                CASE
                    WHEN (COALESCE(e.expected_yesterday, (0)::numeric) > (0)::numeric) THEN round((LEAST(COALESCE(cv.capped_paid_yesterday, (0)::numeric), e.expected_yesterday) / e.expected_yesterday), 4)
                    ELSE
                    CASE
                        WHEN (COALESCE(sd.past_cycle_owed, (0)::numeric) > (0)::numeric) THEN (0)::numeric
                        ELSE (1)::numeric
                    END
                END) AS effective_pct,
                CASE
                    WHEN (COALESCE(e.expected_daily, (0)::numeric) > (0)::numeric) THEN round((COALESCE(rc.paid_today, (0)::numeric) / e.expected_daily), 4)
                    ELSE (0)::numeric
                END AS raw_today_pct,
                CASE
                    WHEN (COALESCE(e.expected_yesterday, (0)::numeric) > (0)::numeric) THEN round((COALESCE(rc.paid_yesterday, (0)::numeric) / e.expected_yesterday), 4)
                    ELSE (0)::numeric
                END AS raw_yesterday_pct,
            COALESCE(e.due_today_count, 0) AS tenants_due,
            LEAST(COALESCE(cv.tenants_paid_today, 0), COALESCE(e.due_today_count, 0)) AS tenants_paid_today,
            LEAST(COALESCE(cv.tenants_paid_yesterday, 0), COALESCE(e.due_yesterday_count, 0)) AS tenants_paid_yesterday,
                CASE
                    WHEN (COALESCE(e.due_today_count, 0) > 0) THEN round(((LEAST(COALESCE(cv.tenants_paid_today, 0), e.due_today_count))::numeric / (e.due_today_count)::numeric), 4)
                    ELSE
                    CASE
                        WHEN (COALESCE(sd.past_cycle_owed, (0)::numeric) > (0)::numeric) THEN (0)::numeric
                        ELSE (1)::numeric
                    END
                END AS coverage_today,
                CASE
                    WHEN (COALESCE(e.due_yesterday_count, 0) > 0) THEN round(((LEAST(COALESCE(cv.tenants_paid_yesterday, 0), e.due_yesterday_count))::numeric / (e.due_yesterday_count)::numeric), 4)
                    ELSE
                    CASE
                        WHEN (COALESCE(sd.past_cycle_owed, (0)::numeric) > (0)::numeric) THEN (0)::numeric
                        ELSE (1)::numeric
                    END
                END AS coverage_yesterday,
            GREATEST(
                CASE
                    WHEN (COALESCE(e.due_today_count, 0) > 0) THEN round(((LEAST(COALESCE(cv.tenants_paid_today, 0), e.due_today_count))::numeric / (e.due_today_count)::numeric), 4)
                    ELSE
                    CASE
                        WHEN (COALESCE(sd.past_cycle_owed, (0)::numeric) > (0)::numeric) THEN (0)::numeric
                        ELSE (1)::numeric
                    END
                END,
                CASE
                    WHEN (COALESCE(e.due_yesterday_count, 0) > 0) THEN round(((LEAST(COALESCE(cv.tenants_paid_yesterday, 0), e.due_yesterday_count))::numeric / (e.due_yesterday_count)::numeric), 4)
                    ELSE
                    CASE
                        WHEN (COALESCE(sd.past_cycle_owed, (0)::numeric) > (0)::numeric) THEN (0)::numeric
                        ELSE (1)::numeric
                    END
                END) AS effective_coverage,
            COALESCE(ws.weekly_plan_count, 0) AS weekly_plan_count,
            COALESCE(ws.weekly_lapsed_count, 0) AS weekly_lapsed_count,
            COALESCE(ws.weekly_expected_week, (0)::numeric) AS weekly_expected_week
           FROM (((((agents a
             LEFT JOIN expected e USING (agent_id))
             LEFT JOIN weekly_stats ws USING (agent_id))
             LEFT JOIN raw_collected rc USING (agent_id))
             LEFT JOIN coverage cv USING (agent_id))
             LEFT JOIN stale_debt sd USING (agent_id))) q
  WHERE ((CURRENT_USER <> 'authenticated'::name) OR (agent_id = auth.uid()) OR can_view_staff_reports(auth.uid()));

-- The "this week" card: same expected as the rule (window unchanged; the caller picks the days).
CREATE OR REPLACE FUNCTION public.agent_expected_week__impl(p_agent_ids uuid[], p_days integer)
 RETURNS TABLE(agent_id uuid, expected_week numeric, collected_week numeric, days_billed integer, day_from date, day_to date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH w AS (
    SELECT ((now() AT TIME ZONE 'Africa/Kampala')::date
              - (GREATEST(COALESCE(p_days, 7), 1) - 1)) AS lo,
           ((now() AT TIME ZONE 'Africa/Kampala')::date) AS hi
  ), ids AS (
    SELECT DISTINCT a.id FROM unnest(p_agent_ids) a(id) WHERE a.id IS NOT NULL
  ), bill AS (
    -- The pinned bill: exactly what the posting gate and the collections
    -- report measure against.
    SELECT e.agent_id, sum(e.expected_ugx) AS exp_sum, count(DISTINCT e.day) AS d_cnt
    -- Same expected as the weekly rule and the daily view (20261027150000).
    FROM w, public._agent_expected_effective__impl((SELECT array_agg(id) FROM ids), w.lo, w.hi) e
    WHERE e.day BETWEEN w.lo AND w.hi
      AND e.agent_id IN (SELECT id FROM ids)
    GROUP BY e.agent_id
  ), coll AS (
    -- Bounded on created_at so the index is usable; the bounds are Kampala
    -- local midnights, matching the day keys above.
    SELECT c.agent_id, sum(c.amount) AS coll_sum
    FROM public.agent_collections c, w
    WHERE c.reversed_at IS NULL
      AND c.created_at >= (w.lo::timestamp AT TIME ZONE 'Africa/Kampala')
      AND c.created_at <  ((w.hi + 1)::timestamp AT TIME ZONE 'Africa/Kampala')
      AND c.agent_id IN (SELECT id FROM ids)
    GROUP BY c.agent_id
  )
  SELECT ids.id,
         COALESCE(bill.exp_sum, 0)::numeric,
         COALESCE(coll.coll_sum, 0)::numeric,
         COALESCE(bill.d_cnt, 0)::int,
         (SELECT lo FROM w),
         (SELECT hi FROM w)
  FROM ids
  LEFT JOIN bill ON bill.agent_id = ids.id
  LEFT JOIN coll ON coll.agent_id = ids.id;
$function$;

-- Grants: the impl stays closed; the view's wrapper and the agent RPC are callable by signed-in users
-- and check the caller themselves.
REVOKE ALL ON FUNCTION public._agent_expected_effective__impl(uuid[], date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._agent_expected_effective__impl(uuid[], date, date) TO service_role;
REVOKE ALL ON FUNCTION public._agent_expected_effective(uuid[], date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._agent_expected_effective(uuid[], date, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_my_expected_days(date, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_expected_days(date, date, uuid) TO authenticated, service_role;

-- Re-save the judged week from the shared source.
SELECT public.snapshot_agent_weekly_posting_eligibility();
