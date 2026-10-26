-- Rollback for 20261026090000_weekly_rule_count_plan_payoff.sql
-- Restores _agent_weekly_posting_compute (from 20261023130000) and _agent_weekly_plan_lines (from
-- 20261023140000): collections capped at each plan's weekly bill, with no credit for finishing a plan.
-- Then re-saves the judged week.
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
  ), bill AS (
    -- One row per (agent, plan): what the plan was billed this week, and which group it is in.
    SELECT e.agent_id,
           e.rent_request_id,
           (array_agg(e.tenant_id) FILTER (WHERE e.tenant_id IS NOT NULL))[1] AS tenant_id,
           sum(e.expected_ugx) AS due,
           bool_or(
             COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date)
               + COALESCE(rr.duration_days, 0) - 1 < w.lo
           ) AS expired
    FROM public.agent_expected_day_plans e
    JOIN public.rent_requests rr ON rr.id = e.rent_request_id
    CROSS JOIN w
    WHERE e.day BETWEEN w.lo AND w.hi
      AND e.agent_id IS NOT NULL
      AND e.expected_ugx > 0
      AND (p_agent_ids IS NULL OR e.agent_id = ANY (p_agent_ids))
    GROUP BY e.agent_id, e.rent_request_id
  ), per_plan AS (
    SELECT b.agent_id, b.expired, b.due,
           LEAST(COALESCE(c.paid, 0), b.due) AS collected
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
  ), bill AS (
    SELECT e.rent_request_id,
           (array_agg(e.tenant_id) FILTER (WHERE e.tenant_id IS NOT NULL))[1] AS tenant_id,
           sum(e.expected_ugx) AS due,
           count(DISTINCT e.day)::int AS billed_days,
           sum(e.expected_ugx) FILTER (WHERE e.day = w.hi) AS last_day_due,
           bool_or(
             COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date)
               + COALESCE(rr.duration_days, 0) - 1 < w.lo
           ) AS expired
    FROM public.agent_expected_day_plans e
    JOIN public.rent_requests rr ON rr.id = e.rent_request_id
    CROSS JOIN w
    WHERE e.agent_id = p_agent_id
      AND e.day BETWEEN w.lo AND w.hi
      AND e.expected_ugx > 0
    GROUP BY e.rent_request_id
  )
  SELECT b.rent_request_id, b.tenant_id, b.expired, b.due,
         LEAST(COALESCE(c.paid, 0), b.due), COALESCE(c.paid, 0),
         b.billed_days, COALESCE(b.last_day_due, 0)
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
  ) c ON true;
$function$;

SELECT public.snapshot_agent_weekly_posting_eligibility();
