-- Arrears may never exceed what a Rent Plan actually still owes.
--
-- v_rent_day_ledger settles pinned days from agent_collections only, while a
-- plan is closed on rent_requests.amount_repaid. Plans repaid through any other
-- path therefore kept every pinned day "open" forever and showed as days behind
-- after they were fully paid. Cap every arrears figure at the plan's real
-- outstanding balance and zero it out once nothing is owed; the day-level
-- carry-forward waterfall in rent_apply_collections_to_days is untouched.
CREATE OR REPLACE VIEW public.v_rent_plan_arrears AS
WITH agg AS (
  SELECT l.rent_request_id,
         count(*) AS days_billed,
         count(*) FILTER (WHERE l.remaining_ugx > 0::numeric
                            AND l.day < (now() AT TIME ZONE 'Africa/Kampala')::date) AS days_behind,
         COALESCE(sum(l.remaining_ugx) FILTER (WHERE l.day < (now() AT TIME ZONE 'Africa/Kampala')::date), 0::numeric) AS raw_arrears_ugx,
         COALESCE(sum(l.remaining_ugx) FILTER (WHERE l.day = (now() AT TIME ZONE 'Africa/Kampala')::date), 0::numeric) AS raw_due_today_ugx,
         COALESCE(sum(l.expected_ugx), 0::numeric) AS billed_to_date_ugx,
         COALESCE(sum(l.settled_ugx), 0::numeric) AS settled_to_date_ugx,
         min(l.day) FILTER (WHERE l.remaining_ugx > 0::numeric
                              AND l.day < (now() AT TIME ZONE 'Africa/Kampala')::date) AS oldest_open_day
  FROM public.v_rent_day_ledger l
  GROUP BY l.rent_request_id
), j AS (
  SELECT a.*,
         COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
         rr.tenant_id,
         CASE
           WHEN rr.status IN ('completed', 'settled', 'closed') THEN 0::numeric
           ELSE GREATEST(0::numeric, COALESCE(rr.total_repayment, 0::numeric) - COALESCE(rr.amount_repaid, 0::numeric))
         END AS owed_ugx
  FROM agg a
  JOIN public.rent_requests rr ON rr.id = a.rent_request_id
)
SELECT j.rent_request_id,
       j.agent_id,
       j.tenant_id,
       j.days_billed,
       CASE WHEN j.owed_ugx <= 0::numeric THEN 0::bigint ELSE j.days_behind END AS days_behind,
       LEAST(j.raw_arrears_ugx, j.owed_ugx) AS arrears_ugx,
       LEAST(j.raw_due_today_ugx, GREATEST(j.owed_ugx - LEAST(j.raw_arrears_ugx, j.owed_ugx), 0::numeric)) AS due_today_ugx,
       j.billed_to_date_ugx,
       j.settled_to_date_ugx,
       CASE WHEN j.owed_ugx <= 0::numeric THEN NULL::date ELSE j.oldest_open_day END AS oldest_open_day
FROM j;