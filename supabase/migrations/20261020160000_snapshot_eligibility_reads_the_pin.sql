-- The nightly eligibility snapshot now records what actually happened.
--
-- It was wrong four separate ways, and an agent found it before we did. IAN
-- MUHWEZI collected UGX 1,150,000 on 2026-10-19 and his app told him 594,799.
--
--   1. The numerator DROPPED cleared plans. Its `active` CTE excluded
--      'completed', so a payment that cleared a tenant outright vanished from
--      the agent's record. Martin's missing 555,201 was exactly that: one
--      payment that finished a Rent Plan. Clearing a tenant is the best outcome
--      available to an agent and it was being erased from their performance.
--
--   2. The denominator counted plans nobody collects on. expected_daily was
--      SUM(daily_repayment) over pending / agent_verified / *_approved / funded
--      / repaying, ignoring the pinned bill entirely. Fleet-wide for 19 Oct it
--      claimed 23,213,870 against a pinned 17,691,185.
--
--   3. It double-counted. The events CTE unions `repayments` with
--      `agent_collections`, and every repayments row in recent days has a
--      matching agent_collections row, so payments present in both were summed
--      twice. (Defect 1 outweighed it: the fleet total still understated by 23%.)
--
--   4. Day buckets were UTC, not Africa/Kampala — a three-hour offset that
--      pushed early-morning collections into the previous day.
--
-- Net effect for 2026-10-19: paid understated by 23%, expected overstated by
-- 31%. That is why 133 agents were rated "Very Bad" over seven days against 8
-- "Very Good", and why the weekly good-standing unlock was near unreachable.
--
-- Now: the same figures the gate uses. expected and tenants_due come from the
-- pin; coverage is measured against it; and `paid` is every non-reversed
-- shilling the agent collected that day whatever the plan's status, because
-- that is the number the agent can verify from their own receipts.
--
-- Only days that were actually pinned are written, so history before the pin
-- existed is left alone rather than rewritten as empty.
CREATE OR REPLACE FUNCTION public.snapshot_agent_daily_eligibility(p_days integer DEFAULT 1)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_rows  int := 0;
  v_start date;
  v_end   date;
BEGIN
  IF p_days IS NULL OR p_days < 1 THEN
    p_days := 1;
  END IF;

  v_end   := (now() AT TIME ZONE 'Africa/Kampala')::date - 1;
  v_start := v_end - (p_days - 1);

  WITH bill AS (
    -- The pinned daily bill: the same rows the posting gate measures against.
    SELECT e.day, e.agent_id, e.rent_request_id, e.tenant_id, e.expected_ugx
    FROM public.agent_expected_day_plans e
    WHERE e.day BETWEEN v_start AND v_end
      AND e.agent_id IS NOT NULL
      AND e.expected_ugx > 0
  ), agent_days AS (
    SELECT b.agent_id, b.day,
           sum(b.expected_ugx)::numeric AS expected_daily,
           count(*)::int                AS tenants_due
    FROM bill b
    GROUP BY b.agent_id, b.day
  ), collected AS (
    -- Every non-reversed collection that day, in Africa/Kampala. No union with
    -- `repayments`: it mirrors agent_collections and unioning it double-counts.
    SELECT ac.agent_id,
           (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS day,
           ac.rent_request_id,
           ac.tenant_id,
           ac.amount::numeric AS amount
    FROM public.agent_collections ac
    WHERE ac.reversed_at IS NULL
      AND ac.amount > 0
      AND ac.agent_id IS NOT NULL
      AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN v_start AND v_end
  ), paid_total AS (
    -- The honest total: what the agent brought in, whatever the plan's status.
    SELECT c.agent_id, c.day, sum(c.amount)::numeric AS paid
    FROM collected c
    GROUP BY c.agent_id, c.day
  ), per_billed_plan AS (
    -- Collections attributed to a plan that was billed that day, so coverage and
    -- capped_paid are measured against the bill rather than the whole book.
    SELECT b.agent_id, b.day, b.rent_request_id,
           min(b.expected_ugx)              AS expected_ugx,
           COALESCE(sum(c.amount), 0)::numeric AS tenant_paid
    FROM bill b
    LEFT JOIN collected c
      ON c.agent_id = b.agent_id
     AND c.day      = b.day
     AND (c.rent_request_id = b.rent_request_id
          OR (c.rent_request_id IS NULL AND c.tenant_id IS NOT NULL
              AND c.tenant_id = b.tenant_id))
    GROUP BY b.agent_id, b.day, b.rent_request_id
  ), against_bill AS (
    SELECT p.agent_id, p.day,
           sum(LEAST(p.tenant_paid, p.expected_ugx))::numeric AS capped_paid,
           count(*) FILTER (WHERE p.tenant_paid > 0)::int     AS tenants_paid
    FROM per_billed_plan p
    GROUP BY p.agent_id, p.day
  ), joined AS (
    SELECT ad.agent_id, ad.day, ad.expected_daily, ad.tenants_due,
           COALESCE(pt.paid, 0)        AS paid,
           COALESCE(ab.capped_paid, 0) AS capped_paid,
           LEAST(COALESCE(ab.tenants_paid, 0), ad.tenants_due) AS tenants_paid,
           CASE WHEN ad.expected_daily > 0
                THEN LEAST(COALESCE(ab.capped_paid, 0), ad.expected_daily) / ad.expected_daily
                ELSE 0 END AS ratio,
           CASE WHEN ad.tenants_due > 0
                THEN LEAST(COALESCE(ab.tenants_paid, 0), ad.tenants_due)::numeric / ad.tenants_due
                ELSE 0 END AS coverage
    FROM agent_days ad
    LEFT JOIN paid_total  pt ON pt.agent_id = ad.agent_id AND pt.day = ad.day
    LEFT JOIN against_bill ab ON ab.agent_id = ad.agent_id AND ab.day = ad.day
  )
  INSERT INTO public.agent_daily_eligibility_history AS h
    (agent_id, day, expected_daily, paid, ratio, rating, status, active_count,
     tenants_due, tenants_paid, coverage_pct, capped_paid, updated_at)
  SELECT
    j.agent_id, j.day, j.expected_daily, j.paid, j.ratio,
    public._classify_daily_rating(j.tenants_due, j.ratio, j.coverage),
    CASE
      WHEN j.tenants_due <= 0 THEN 'starter'
      WHEN public._classify_daily_rating(j.tenants_due, j.ratio, j.coverage)
             IN ('Good','Very Good') THEN 'good'
      ELSE 'blocked'
    END,
    j.tenants_due,
    j.tenants_due, j.tenants_paid, j.coverage, j.capped_paid,
    now()
  FROM joined j
  ON CONFLICT (agent_id, day) DO UPDATE
    SET expected_daily = EXCLUDED.expected_daily,
        paid           = EXCLUDED.paid,
        ratio          = EXCLUDED.ratio,
        rating         = EXCLUDED.rating,
        status         = EXCLUDED.status,
        active_count   = EXCLUDED.active_count,
        tenants_due    = EXCLUDED.tenants_due,
        tenants_paid   = EXCLUDED.tenants_paid,
        coverage_pct   = EXCLUDED.coverage_pct,
        capped_paid    = EXCLUDED.capped_paid,
        updated_at     = now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END
$fn$;
