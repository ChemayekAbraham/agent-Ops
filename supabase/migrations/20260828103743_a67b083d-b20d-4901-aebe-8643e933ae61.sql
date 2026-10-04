-- 1) Coverage-aware daily eligibility view -----------------------------------
CREATE OR REPLACE VIEW public.v_agent_daily_eligibility AS
WITH active_rents AS (
  SELECT rr.agent_id, rr.id AS rent_request_id, rr.tenant_id,
         rr.daily_repayment, rr.amount_repaid, rr.total_repayment
  FROM rent_requests rr
  WHERE rr.status = ANY (ARRAY['funded'::text,'repaying'::text])
    AND COALESCE(rr.agent_payment_status,'paying') <> 'not_paying'
), paused AS (
  SELECT DISTINCT p.rent_request_id FROM rent_repayment_pauses p
  WHERE p.status = 'active' AND p.resumed_at IS NULL
    AND (p.resume_on IS NULL OR p.resume_on >= (now() AT TIME ZONE 'Africa/Kampala')::date)
), reversed AS (
  SELECT DISTINCT rent_request_id FROM agent_tenant_float_reversals
), landlord_settled AS (
  SELECT DISTINCT a.rent_request_id FROM agent_landlord_float_allocations a
  WHERE a.rent_request_id IS NOT NULL AND a.paid_out_amount > 0
), eligible_rents AS (
  SELECT ar.agent_id, ar.rent_request_id, ar.tenant_id,
         COALESCE(ar.daily_repayment,0)::numeric AS daily_repayment
  FROM active_rents ar
  LEFT JOIN reversed rv ON rv.rent_request_id = ar.rent_request_id
  LEFT JOIN paused pz ON pz.rent_request_id = ar.rent_request_id
  LEFT JOIN landlord_settled ls ON ls.rent_request_id = ar.rent_request_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS open_allocs FROM agent_landlord_float_allocations oa_1
    WHERE oa_1.rent_request_id = ar.rent_request_id
      AND oa_1.status = ANY (ARRAY['open'::text,'partially_paid'::text,'return_pending'::text])
  ) oa ON true
  WHERE (rv.rent_request_id IS NULL OR COALESCE(ar.amount_repaid,0) > 0)
    AND pz.rent_request_id IS NULL
    AND (COALESCE(ar.total_repayment,0) - COALESCE(ar.amount_repaid,0)) > 0
    AND (ls.rent_request_id IS NOT NULL OR COALESCE(ar.amount_repaid,0) > 0
         OR COALESCE(oa.open_allocs,0) = 0)
), expected AS (
  SELECT agent_id,
         count(*)::integer AS active_count,
         COALESCE(sum(daily_repayment),0)::numeric AS expected_daily
  FROM eligible_rents GROUP BY agent_id
), collection_events AS (
  SELECT ac.agent_id, ac.rent_request_id, ac.tenant_id, ac.amount,
         (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS day
  FROM agent_collections ac
  WHERE ac.created_at >= (((now() AT TIME ZONE 'Africa/Kampala')::date - 1)::timestamp AT TIME ZONE 'Africa/Kampala')
), collected AS (
  SELECT ce.agent_id,
         sum(CASE WHEN ce.day = (now() AT TIME ZONE 'Africa/Kampala')::date THEN ce.amount ELSE 0 END) AS paid_today,
         sum(CASE WHEN ce.day = ((now() AT TIME ZONE 'Africa/Kampala')::date - 1) THEN ce.amount ELSE 0 END) AS paid_yesterday
  FROM collection_events ce GROUP BY ce.agent_id
),
-- Match each collection to an eligible tenant plan (by plan, else by tenant)
matched AS (
  SELECT er.agent_id, er.rent_request_id, er.daily_repayment, ce.day,
         sum(ce.amount)::numeric AS tenant_paid
  FROM eligible_rents er
  JOIN collection_events ce
    ON ce.agent_id = er.agent_id
   AND (ce.rent_request_id = er.rent_request_id
        OR (ce.rent_request_id IS NULL AND ce.tenant_id IS NOT NULL
            AND ce.tenant_id = er.tenant_id))
  GROUP BY er.agent_id, er.rent_request_id, er.daily_repayment, ce.day
), per_day AS (
  SELECT m.agent_id, m.day,
         -- per-tenant contribution capped at that tenant's own daily amount
         sum(LEAST(m.tenant_paid, GREATEST(m.daily_repayment,0)))::numeric AS capped_paid,
         count(*) FILTER (WHERE m.tenant_paid > 0)::integer AS tenants_paid
  FROM matched m GROUP BY m.agent_id, m.day
), coverage AS (
  SELECT agent_id,
         COALESCE(sum(capped_paid) FILTER (WHERE day = (now() AT TIME ZONE 'Africa/Kampala')::date),0)::numeric AS capped_paid_today,
         COALESCE(sum(capped_paid) FILTER (WHERE day = ((now() AT TIME ZONE 'Africa/Kampala')::date - 1)),0)::numeric AS capped_paid_yesterday,
         COALESCE(max(tenants_paid) FILTER (WHERE day = (now() AT TIME ZONE 'Africa/Kampala')::date),0)::integer AS tenants_paid_today,
         COALESCE(max(tenants_paid) FILTER (WHERE day = ((now() AT TIME ZONE 'Africa/Kampala')::date - 1)),0)::integer AS tenants_paid_yesterday
  FROM per_day GROUP BY agent_id
)
SELECT e.agent_id,
  e.active_count,
  e.expected_daily,
  COALESCE(c.paid_today,0)::numeric      AS paid_today,
  COALESCE(c.paid_yesterday,0)::numeric  AS paid_yesterday,
  CASE WHEN e.expected_daily > 0
    THEN round(LEAST(COALESCE(cv.capped_paid_today,0), e.expected_daily) / e.expected_daily, 4)
    ELSE 0 END AS today_pct,
  CASE WHEN e.expected_daily > 0
    THEN round(LEAST(COALESCE(cv.capped_paid_yesterday,0), e.expected_daily) / e.expected_daily, 4)
    ELSE 0 END AS yesterday_pct,
  CASE WHEN e.expected_daily > 0
    THEN round(GREATEST(
           LEAST(COALESCE(cv.capped_paid_today,0), e.expected_daily),
           LEAST(COALESCE(cv.capped_paid_yesterday,0), e.expected_daily)
         ) / e.expected_daily, 4)
    ELSE 0 END AS effective_pct,
  -- raw (uncapped) amount ratios, kept for display/diagnostics only
  CASE WHEN e.expected_daily > 0
    THEN round(COALESCE(c.paid_today,0) / e.expected_daily, 4) ELSE 0 END AS raw_today_pct,
  CASE WHEN e.expected_daily > 0
    THEN round(COALESCE(c.paid_yesterday,0) / e.expected_daily, 4) ELSE 0 END AS raw_yesterday_pct,
  e.active_count AS tenants_due,
  LEAST(COALESCE(cv.tenants_paid_today,0), e.active_count)     AS tenants_paid_today,
  LEAST(COALESCE(cv.tenants_paid_yesterday,0), e.active_count) AS tenants_paid_yesterday,
  CASE WHEN e.active_count > 0
    THEN round(LEAST(COALESCE(cv.tenants_paid_today,0), e.active_count)::numeric / e.active_count, 4)
    ELSE 0 END AS coverage_today,
  CASE WHEN e.active_count > 0
    THEN round(LEAST(COALESCE(cv.tenants_paid_yesterday,0), e.active_count)::numeric / e.active_count, 4)
    ELSE 0 END AS coverage_yesterday,
  CASE WHEN e.active_count > 0
    THEN round(GREATEST(
           LEAST(COALESCE(cv.tenants_paid_today,0), e.active_count),
           LEAST(COALESCE(cv.tenants_paid_yesterday,0), e.active_count)
         )::numeric / e.active_count, 4)
    ELSE 0 END AS effective_coverage
FROM expected e
LEFT JOIN collected c USING (agent_id)
LEFT JOIN coverage cv USING (agent_id);

ALTER VIEW public.v_agent_daily_eligibility SET (security_invoker = on);
GRANT SELECT ON public.v_agent_daily_eligibility TO authenticated, anon, service_role;

COMMENT ON VIEW public.v_agent_daily_eligibility IS
'Daily agent collection performance. today_pct/yesterday_pct/effective_pct are COVERAGE-SAFE: each tenant contributes at most their own daily_repayment, so over-collecting from one tenant can no longer mask tenants who paid nothing. raw_*_pct keep the old uncapped amount ratio for display. tenants_due/tenants_paid_*/coverage_* express how many due tenants actually paid.';

-- 2) Coverage-gated rating classifier ---------------------------------------
CREATE OR REPLACE FUNCTION public._classify_daily_rating(
  p_active_count integer, p_ratio numeric, p_coverage numeric
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT CASE
      WHEN COALESCE(p_ratio,0) >= 0.75 THEN 0
      WHEN COALESCE(p_ratio,0) >= 0.50 THEN 1
      WHEN COALESCE(p_ratio,0) >= 0.15 THEN 2
      WHEN COALESCE(p_ratio,0) >= 0.05 THEN 3
      ELSE 4
    END AS idx,
    CASE
      WHEN COALESCE(p_coverage,1) >= 1    THEN 0   -- every due tenant paid
      WHEN COALESCE(p_coverage,1) >= 0.50 THEN 1   -- partial coverage: one step down
      ELSE 2                                       -- low coverage: two steps down
    END AS demote
  )
  SELECT CASE
    WHEN p_active_count <= 0 THEN 'Starter'
    ELSE (ARRAY['Very Good','Good','Fair','Bad','Very Bad'])[
           LEAST(4, (SELECT idx + demote FROM base)) + 1
         ]
  END;
$function$;

COMMENT ON FUNCTION public._classify_daily_rating(integer, numeric, numeric) IS
'Coverage-gated daily rating. p_ratio must be the per-tenant-capped collection ratio; p_coverage is tenants_paid/tenants_due. Below full coverage the rating drops one tier, below half coverage two tiers, so "Very Good" requires every due tenant to have paid.';

-- Legacy 2-arg form kept for backward compatibility; assumes full coverage.
CREATE OR REPLACE FUNCTION public._classify_daily_rating(
  p_active_count integer, p_ratio numeric
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT public._classify_daily_rating(p_active_count, p_ratio, 1::numeric);
$function$;

-- 3) App-facing RPC: expose coverage ----------------------------------------
DROP FUNCTION IF EXISTS public.get_agent_daily_eligibility(uuid[]);
CREATE FUNCTION public.get_agent_daily_eligibility(p_agent_ids uuid[])
RETURNS TABLE(
  agent_id uuid, active_count integer, expected_daily numeric,
  paid_today numeric, paid_yesterday numeric,
  today_pct numeric, yesterday_pct numeric, effective_pct numeric,
  raw_today_pct numeric, raw_yesterday_pct numeric,
  tenants_due integer, tenants_paid_today integer, tenants_paid_yesterday integer,
  coverage_today numeric, coverage_yesterday numeric, effective_coverage numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT v.agent_id, v.active_count, v.expected_daily,
         v.paid_today, v.paid_yesterday,
         v.today_pct, v.yesterday_pct, v.effective_pct,
         v.raw_today_pct, v.raw_yesterday_pct,
         v.tenants_due, v.tenants_paid_today, v.tenants_paid_yesterday,
         v.coverage_today, v.coverage_yesterday, v.effective_coverage
  FROM public.v_agent_daily_eligibility v
  WHERE v.agent_id = ANY (p_agent_ids);
$function$;

GRANT EXECUTE ON FUNCTION public.get_agent_daily_eligibility(uuid[])
  TO authenticated, service_role;

-- 4) Nightly snapshot: store coverage + coverage-gated rating ---------------
ALTER TABLE public.agent_daily_eligibility_history
  ADD COLUMN IF NOT EXISTS tenants_due integer,
  ADD COLUMN IF NOT EXISTS tenants_paid integer,
  ADD COLUMN IF NOT EXISTS coverage_pct numeric,
  ADD COLUMN IF NOT EXISTS capped_paid numeric;

CREATE OR REPLACE FUNCTION public.snapshot_agent_daily_eligibility(p_days integer DEFAULT 1)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rows int := 0;
  v_start date;
  v_end   date;
BEGIN
  IF p_days IS NULL OR p_days < 1 THEN
    p_days := 1;
  END IF;
  v_end := (now() AT TIME ZONE 'UTC')::date - 1;
  v_start := v_end - (p_days - 1);

  WITH active AS (
    SELECT rr.agent_id, rr.id AS rent_request_id, rr.tenant_id,
           COALESCE(rr.daily_repayment, 0)::numeric AS daily_repayment
    FROM public.rent_requests rr
    LEFT JOIN public.agent_tenant_float_reversals rev
      ON rev.rent_request_id = rr.id
    WHERE rr.agent_id IS NOT NULL
      AND rr.status IN (
        'pending','agent_verified','tenant_ops_approved',
        'agent_ops_approved','landlord_ops_approved',
        'coo_approved','funded','repaying'
      )
      AND NOT (rev.rent_request_id IS NOT NULL AND COALESCE(rr.amount_repaid,0) <= 0)
  ),
  agent_expected AS (
    SELECT agent_id,
           SUM(daily_repayment)::numeric AS expected_daily,
           COUNT(*)::int                 AS active_count
    FROM active GROUP BY agent_id
  ),
  days AS (
    SELECT generate_series(v_start, v_end, INTERVAL '1 day')::date AS day
  ),
  agent_days AS (
    SELECT ae.agent_id, ae.expected_daily, ae.active_count, d.day
    FROM agent_expected ae CROSS JOIN days d
  ),
  -- per (tenant plan × day) collections from both sources
  events AS (
    SELECT a.agent_id, a.rent_request_id, a.daily_repayment,
           (r.created_at AT TIME ZONE 'UTC')::date AS day,
           COALESCE(r.amount,0)::numeric AS amount
    FROM public.repayments r
    JOIN active a ON a.rent_request_id = r.rent_request_id
    WHERE (r.created_at AT TIME ZONE 'UTC')::date BETWEEN v_start AND v_end
    UNION ALL
    SELECT a.agent_id, a.rent_request_id, a.daily_repayment,
           (ac.created_at AT TIME ZONE 'UTC')::date AS day,
           COALESCE(ac.amount,0)::numeric AS amount
    FROM public.agent_collections ac
    JOIN active a
      ON a.agent_id = ac.agent_id
     AND (ac.rent_request_id = a.rent_request_id
          OR (ac.rent_request_id IS NULL AND ac.tenant_id IS NOT NULL
              AND ac.tenant_id = a.tenant_id))
    WHERE (ac.created_at AT TIME ZONE 'UTC')::date BETWEEN v_start AND v_end
  ),
  per_tenant_day AS (
    SELECT agent_id, rent_request_id, day,
           MAX(daily_repayment) AS daily_repayment,
           SUM(amount)::numeric AS tenant_paid
    FROM events GROUP BY agent_id, rent_request_id, day
  ),
  paid_total AS (
    SELECT agent_id, day,
           SUM(tenant_paid)::numeric AS paid,
           SUM(LEAST(tenant_paid, GREATEST(daily_repayment,0)))::numeric AS capped_paid,
           COUNT(*) FILTER (WHERE tenant_paid > 0)::int AS tenants_paid
    FROM per_tenant_day GROUP BY agent_id, day
  ),
  joined AS (
    SELECT ad.agent_id, ad.day, ad.expected_daily, ad.active_count,
           COALESCE(p.paid,0)        AS paid,
           COALESCE(p.capped_paid,0) AS capped_paid,
           LEAST(COALESCE(p.tenants_paid,0), ad.active_count) AS tenants_paid,
           CASE WHEN ad.expected_daily > 0
             THEN LEAST(COALESCE(p.capped_paid,0), ad.expected_daily) / ad.expected_daily
             ELSE 0 END AS ratio,
           CASE WHEN ad.active_count > 0
             THEN LEAST(COALESCE(p.tenants_paid,0), ad.active_count)::numeric / ad.active_count
             ELSE 0 END AS coverage
    FROM agent_days ad
    LEFT JOIN paid_total p
      ON p.agent_id = ad.agent_id AND p.day = ad.day
  )
  INSERT INTO public.agent_daily_eligibility_history AS h
    (agent_id, day, expected_daily, paid, ratio, rating, status, active_count,
     tenants_due, tenants_paid, coverage_pct, capped_paid, updated_at)
  SELECT
    j.agent_id, j.day, j.expected_daily, j.paid, j.ratio,
    public._classify_daily_rating(j.active_count, j.ratio, j.coverage),
    CASE
      WHEN j.active_count <= 0 THEN 'starter'
      WHEN public._classify_daily_rating(j.active_count, j.ratio, j.coverage)
             IN ('Good','Very Good') THEN 'good'
      ELSE 'blocked'
    END,
    j.active_count,
    j.active_count, j.tenants_paid, j.coverage, j.capped_paid,
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
END;
$function$;