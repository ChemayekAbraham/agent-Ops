-- Weekly posting rule: expired tenants whose daily billing stopped count as a normal week.
--
-- The daily bill (pin_agent_expected_day) never bills an expired plan for more than it still owes:
-- once the unpaid daily bills add up to the remaining balance, no new days are added. Those tenants
-- still owe and still pay, but the weekly rule capped each tenant at what was billed that week, so
-- their payments barely counted (e.g. 26 Oct: Shafeeq Ssenabulya had 11 such tenants, billed 1-3 days
-- each; tenants paying on 26-27 Oct counted almost nothing). Week of 22 Oct: 274 tenants, 64 agents.
-- Decided with Pius 2026-10-27: treat them as normal tenants for the weekly target.
--
-- For an expired, repaying plan the agent owns (assigned_agent_id, else agent_id), that is daily,
-- still owes, isn't paused or marked not_paying, has been billed before, and is billable this week:
--   normal week  = daily_repayment x days it would be billed this week
--                  (from the later of the week start, rent_plan_billable_from and the expired-plan
--                   billing go-live, 19 Oct 2026, up to the week end or today)
--   due used     = GREATEST(what was actually billed, LEAST(normal week, what was left at week start))
--   counted      = LEAST(paid this week, due used)
-- So the target rises by the missing days and payments count up to a normal week; no tenant counts for
-- more than a normal week (or more than they owed), so overpayment still can't cover another tenant.
-- Plans finished in the week keep the 20261026090000 rule. Weekly-frequency plans are unchanged.
-- Only the weekly target and the Weekly Performance page change; tenants' bills and balances don't.

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
  ), pins AS (
    -- What each plan was actually billed this week.
    SELECT e.agent_id, e.rent_request_id,
           (array_agg(e.tenant_id) FILTER (WHERE e.tenant_id IS NOT NULL))[1] AS tenant_id,
           sum(e.expected_ugx) AS due
    FROM public.agent_expected_day_plans e
    CROSS JOIN w
    WHERE e.day BETWEEN w.lo AND w.hi
      AND e.agent_id IS NOT NULL
      AND e.expected_ugx > 0
      AND (p_agent_ids IS NULL OR e.agent_id = ANY (p_agent_ids))
    GROUP BY e.agent_id, e.rent_request_id
  ), cand AS (
    -- Expired tenants who should count as a normal week (20261027100000).
    SELECT COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id, rr.id AS rent_request_id,
           rr.daily_repayment
             * (w.hi - GREATEST(w.lo, public.rent_plan_billable_from(rr.id), public.agent_arrears_billing_go_live()) + 1) AS normal_week
    FROM public.rent_requests rr
    CROSS JOIN w
    WHERE rr.status = 'repaying'
      AND COALESCE(rr.agent_payment_status, 'paying') <> 'not_paying'
      AND lower(COALESCE(rr.repayment_frequency, 'daily')) <> 'weekly'
      AND COALESCE(rr.daily_repayment, 0) > 0
      AND COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0) > 0
      AND COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date)
            + COALESCE(rr.duration_days, 0) - 1 < w.lo
      AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL
      AND (p_agent_ids IS NULL OR COALESCE(rr.assigned_agent_id, rr.agent_id) = ANY (p_agent_ids))
      AND GREATEST(w.lo, public.rent_plan_billable_from(rr.id), public.agent_arrears_billing_go_live()) <= w.hi
      AND EXISTS (SELECT 1 FROM public.agent_expected_day_plans e0 WHERE e0.rent_request_id = rr.id)
      AND NOT EXISTS (
        SELECT 1 FROM public.rent_repayment_pauses z
        WHERE z.rent_request_id = rr.id AND z.status = 'active' AND z.resumed_at IS NULL
          AND (z.resume_on IS NULL OR z.resume_on >= w.hi))
  ), bill AS (
    SELECT k.agent_id, k.rent_request_id,
           COALESCE(p.tenant_id, rr.tenant_id) AS tenant_id,
           COALESCE(p.due, 0) AS billed,
           c.normal_week,
           COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date)
             + COALESCE(rr.duration_days, 0) - 1 < w.lo AS expired,
           -- Finished during the week (20261026090000): completed, billed this week, never billed after.
           (p.rent_request_id IS NOT NULL AND rr.status = 'completed'
             AND NOT EXISTS (SELECT 1 FROM public.agent_expected_day_plans x
                             WHERE x.rent_request_id = k.rent_request_id AND x.day > w.hi)) AS finished,
           COALESCE(rr.total_repayment, 0) AS total_repayment,
           COALESCE(rr.amount_repaid, 0) AS amount_repaid
    FROM (SELECT agent_id, rent_request_id FROM pins
          UNION
          SELECT agent_id, rent_request_id FROM cand) k
    JOIN public.rent_requests rr ON rr.id = k.rent_request_id
    CROSS JOIN w
    LEFT JOIN pins p ON p.agent_id = k.agent_id AND p.rent_request_id = k.rent_request_id
    LEFT JOIN cand c ON c.agent_id = k.agent_id AND c.rent_request_id = k.rent_request_id
  ), paid AS (
    SELECT b.*, COALESCE(c.paid, 0) AS paid,
           GREATEST(b.total_repayment - (b.amount_repaid - COALESCE(c.paid, 0)), 0) AS left_at_start
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
  ), per_plan AS (
    SELECT q.agent_id, q.expired, q.due,
           CASE WHEN q.finished
                THEN LEAST(q.paid, GREATEST(q.due, q.left_at_start))
                ELSE LEAST(q.paid, q.due)
           END AS collected
    FROM (
      SELECT pd.*,
             CASE WHEN pd.normal_week IS NOT NULL
                  THEN GREATEST(pd.billed, LEAST(pd.normal_week, pd.left_at_start))
                  ELSE pd.billed
             END AS due
      FROM paid pd
    ) q
    WHERE q.due > 0
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
  ), pins AS (
    SELECT e.rent_request_id,
           (array_agg(e.tenant_id) FILTER (WHERE e.tenant_id IS NOT NULL))[1] AS tenant_id,
           sum(e.expected_ugx) AS due,
           count(DISTINCT e.day)::int AS billed_days,
           sum(e.expected_ugx) FILTER (WHERE e.day = w.hi) AS last_day_due
    FROM public.agent_expected_day_plans e
    CROSS JOIN w
    WHERE e.agent_id = p_agent_id
      AND e.day BETWEEN w.lo AND w.hi
      AND e.expected_ugx > 0
    GROUP BY e.rent_request_id, w.hi
  ), cand AS (
    -- Expired tenants who should count as a normal week (20261027100000), up to p_through.
    SELECT rr.id AS rent_request_id, rr.daily_repayment,
           rr.daily_repayment
             * (w.hi - GREATEST(w.lo, public.rent_plan_billable_from(rr.id), public.agent_arrears_billing_go_live()) + 1) AS normal_week
    FROM public.rent_requests rr
    CROSS JOIN w
    WHERE COALESCE(rr.assigned_agent_id, rr.agent_id) = p_agent_id
      AND rr.status = 'repaying'
      AND COALESCE(rr.agent_payment_status, 'paying') <> 'not_paying'
      AND lower(COALESCE(rr.repayment_frequency, 'daily')) <> 'weekly'
      AND COALESCE(rr.daily_repayment, 0) > 0
      AND COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0) > 0
      AND COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date)
            + COALESCE(rr.duration_days, 0) - 1 < w.lo
      AND GREATEST(w.lo, public.rent_plan_billable_from(rr.id), public.agent_arrears_billing_go_live()) <= w.hi
      AND EXISTS (SELECT 1 FROM public.agent_expected_day_plans e0 WHERE e0.rent_request_id = rr.id)
      AND NOT EXISTS (
        SELECT 1 FROM public.rent_repayment_pauses z
        WHERE z.rent_request_id = rr.id AND z.status = 'active' AND z.resumed_at IS NULL
          AND (z.resume_on IS NULL OR z.resume_on >= w.hi))
  ), bill AS (
    SELECT k.rent_request_id,
           COALESCE(p.tenant_id, rr.tenant_id) AS tenant_id,
           COALESCE(p.due, 0) AS billed,
           COALESCE(p.billed_days, 0) AS billed_days,
           COALESCE(p.last_day_due, 0) AS billed_last_day,
           c.normal_week, c.daily_repayment,
           COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date)
             + COALESCE(rr.duration_days, 0) - 1 < w.lo AS expired,
           -- Finished during the week (20261026090000), measured up to p_through.
           (p.rent_request_id IS NOT NULL AND rr.status = 'completed'
             AND NOT EXISTS (SELECT 1 FROM public.agent_expected_day_plans x
                             WHERE x.rent_request_id = k.rent_request_id AND x.day > w.hi)) AS finished,
           COALESCE(rr.total_repayment, 0) AS total_repayment,
           COALESCE(rr.amount_repaid, 0) AS amount_repaid
    FROM (SELECT rent_request_id FROM pins UNION SELECT rent_request_id FROM cand) k
    JOIN public.rent_requests rr ON rr.id = k.rent_request_id
    CROSS JOIN w
    LEFT JOIN pins p ON p.rent_request_id = k.rent_request_id
    LEFT JOIN cand c ON c.rent_request_id = k.rent_request_id
  ), paid AS (
    SELECT b.*, COALESCE(c.paid, 0) AS paid,
           GREATEST(b.total_repayment - (b.amount_repaid - COALESCE(c.paid, 0)), 0) AS left_at_start
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
  ), q AS (
    SELECT pd.*,
           CASE WHEN pd.normal_week IS NOT NULL
                THEN GREATEST(pd.billed, LEAST(pd.normal_week, pd.left_at_start))
                ELSE pd.billed
           END AS due_used
    FROM paid pd
  )
  SELECT q.rent_request_id, q.tenant_id, q.expired, q.due_used,
         CASE WHEN q.finished
              THEN LEAST(q.paid, GREATEST(q.due_used, q.left_at_start))
              ELSE LEAST(q.paid, q.due_used)
         END,
         q.paid,
         q.billed_days,
         CASE
           -- A finished plan won't be billed again: nothing to project for the days left.
           WHEN q.finished THEN 0
           -- Counted as a normal week: one more day's payment per day left, while anything is still owed.
           WHEN q.normal_week IS NOT NULL
             THEN LEAST(q.daily_repayment, GREATEST(q.left_at_start - q.due_used, 0))
           ELSE q.billed_last_day
         END
  FROM q
  WHERE q.due_used > 0;
$function$;

-- Re-save the judged week with the new counting.
SELECT public.snapshot_agent_weekly_posting_eligibility();
