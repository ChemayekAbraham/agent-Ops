-- tops_shortfall_age_fallback: how far behind each Rent Plan is, worked out from the
-- pinned daily bills (agent_expected_day_plans) and the receipt book (agent_collections)
-- instead of tops_open_instalments_asof. Read-only, additive: one new function, nothing
-- existing is altered.
--
-- Why it exists: tops_shortfall_lines takes days_behind from tops_open_instalments_asof,
-- which only has instalments for plans whose repayment frequency is locked (a handful).
-- Almost every plan billed today has none, so its age came out blank.
--
-- Method (first in, first out): for each plan, bills are the pinned expected_ugx per
-- Kampala day up to p_asof. Payments are the non-reversed agent_collections (amount > 0,
-- reversed_at IS NULL) by Kampala day of created_at, up to p_asof. Payments settle the
-- oldest bill first, so the bill for day D is fully covered exactly when the cumulative
-- bill up to D is <= cumulative payments. The oldest unpaid day is the earliest pinned
-- day whose cumulative bill exceeds cumulative payments; days_behind = p_asof - that day
-- (0 = the bill for p_asof itself is the oldest one still open).
--
-- Only payments made on or after a plan's FIRST pinned day count. Earlier money paid off
-- days that were never billed (back-dated term start, or before the daily pin existed on
-- 2026-09-10) and must not be allowed to settle bills that were. Plans that are completed
-- or cancelled (the live rent_requests.status values) are excluded. A plan with no bill
-- yet, or whose bills are all covered, returns no row.
--
-- Every column reference is alias-qualified: the RETURNS TABLE output names are also
-- PL/pgSQL variables and an unqualified reference raises "column reference is ambiguous".

CREATE OR REPLACE FUNCTION public.tops_shortfall_age_fallback(p_asof date)
RETURNS TABLE (
  rent_request_id uuid,
  oldest_unpaid_day date,
  days_behind int,
  basis text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  IF p_asof IS NULL THEN RAISE EXCEPTION 'p_asof is required'; END IF;

  RETURN QUERY
  WITH bills AS (
    SELECT
      dp.rent_request_id AS rr_id,
      dp.day AS bill_day,
      SUM(dp.expected_ugx) OVER (PARTITION BY dp.rent_request_id ORDER BY dp.day) AS cum_bill,
      MIN(dp.day) OVER (PARTITION BY dp.rent_request_id) AS first_day
    FROM public.agent_expected_day_plans dp
    WHERE dp.day <= p_asof
      AND dp.expected_ugx > 0
  ),
  plans AS (
    SELECT DISTINCT b.rr_id, b.first_day FROM bills b
  ),
  paid AS (
    SELECT pl.rr_id, COALESCE(SUM(ac.amount), 0) AS paid_total
    FROM plans pl
    LEFT JOIN public.agent_collections ac
      ON ac.rent_request_id = pl.rr_id
     AND ac.amount > 0
     AND ac.reversed_at IS NULL
     AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN pl.first_day AND p_asof
    GROUP BY pl.rr_id
  ),
  oldest AS (
    SELECT b.rr_id, MIN(b.bill_day) AS oldest_day
    FROM bills b
    JOIN paid pd ON pd.rr_id = b.rr_id
    WHERE b.cum_bill > pd.paid_total
    GROUP BY b.rr_id
  )
  SELECT
    o.rr_id,
    o.oldest_day,
    (p_asof - o.oldest_day)::int,
    'pinned_bills_fifo'::text
  FROM oldest o
  JOIN public.rent_requests rr ON rr.id = o.rr_id
  WHERE rr.status NOT IN ('completed', 'cancelled')
  ORDER BY o.oldest_day, o.rr_id;
END;
$function$;

-- This schema's default privileges auto-grant new functions to anon; revoke explicitly.
REVOKE ALL ON FUNCTION public.tops_shortfall_age_fallback(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_shortfall_age_fallback(date) TO authenticated;
