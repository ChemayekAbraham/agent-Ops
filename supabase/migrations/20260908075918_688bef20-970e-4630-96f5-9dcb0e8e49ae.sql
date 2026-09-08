-- ---------------------------------------------------------------
-- Weekly plans are tracked separately from the daily eligibility gate.
-- A weekly plan only re-enters the daily gate when its week has lapsed
-- with no collection (start + 7 days <= today AND nothing collected in
-- the last 7 Kampala days). Amounts/ledgers/wallets untouched.
-- ---------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_agent_daily_eligibility AS
WITH day_start AS (
  SELECT ((now() AT TIME ZONE 'Africa/Kampala')::date::timestamp AT TIME ZONE 'Africa/Kampala') AS ts,
         (now() AT TIME ZONE 'Africa/Kampala')::date       AS d_today,
         (now() AT TIME ZONE 'Africa/Kampala')::date - 1   AS d_yesterday,
         (((now() AT TIME ZONE 'Africa/Kampala')::date - 6)::timestamp AT TIME ZONE 'Africa/Kampala') AS week_ts
),
all_rents AS (
  SELECT rr.agent_id,
         rr.id AS rent_request_id,
         rr.tenant_id,
         rr.daily_repayment,
         rr.amount_repaid,
         rr.total_repayment,
         rr.funded_at,
         COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date) AS starts_on,
         (lower(COALESCE(rr.repayment_frequency,'daily')) = 'weekly'
          OR public.rent_request_is_weekly_shape(rr.duration_days, rr.registration_type)) AS is_weekly
  FROM public.rent_requests rr
  WHERE rr.status IN ('funded','repaying')
    AND COALESCE(rr.agent_payment_status,'paying') <> 'not_paying'
),
week_paid AS (
  SELECT ar.rent_request_id
  FROM all_rents ar
  CROSS JOIN day_start ds
  WHERE ar.is_weekly
    AND EXISTS (
      SELECT 1 FROM public.agent_collections ac
      WHERE ac.created_at >= ds.week_ts
        AND ac.amount > 0
        AND (ac.rent_request_id = ar.rent_request_id
             OR (ac.rent_request_id IS NULL AND ac.tenant_id IS NOT NULL AND ac.tenant_id = ar.tenant_id))
    )
),
active_rents AS (
  SELECT ar.*,
         (ar.is_weekly
          AND ar.starts_on IS NOT NULL
          AND ar.starts_on + 7 <= ds.d_today
          AND wp.rent_request_id IS NULL) AS weekly_lapsed
  FROM all_rents ar
  CROSS JOIN day_start ds
  LEFT JOIN week_paid wp ON wp.rent_request_id = ar.rent_request_id
),
prior_paid AS (
  SELECT ac.rent_request_id, sum(ac.amount) AS paid_before_today
  FROM public.agent_collections ac CROSS JOIN day_start ds
  WHERE ac.rent_request_id IS NOT NULL AND ac.created_at < ds.ts
  GROUP BY ac.rent_request_id
),
paused AS (
  SELECT DISTINCT p.rent_request_id
  FROM public.rent_repayment_pauses p
  WHERE p.status = 'active' AND p.resumed_at IS NULL
    AND (p.resume_on IS NULL OR p.resume_on >= (now() AT TIME ZONE 'Africa/Kampala')::date)
),
reversed AS (
  SELECT DISTINCT r.rent_request_id FROM public.agent_tenant_float_reversals r
),
landlord_settled AS (
  SELECT DISTINCT a.rent_request_id
  FROM public.agent_landlord_float_allocations a
  WHERE a.rent_request_id IS NOT NULL AND a.paid_out_amount > 0
),
alloc_activity AS (
  SELECT a.rent_request_id,
         max(GREATEST(a.created_at, COALESCE(a.updated_at, a.created_at))) AS last_change
  FROM public.agent_landlord_float_allocations a
  WHERE a.rent_request_id IS NOT NULL
  GROUP BY a.rent_request_id
),
-- Plans that pass the disbursement/owing/pause tests (frequency-agnostic)
live_rents AS (
  SELECT ar.*
  FROM active_rents ar
  CROSS JOIN day_start ds
  LEFT JOIN prior_paid pp ON pp.rent_request_id = ar.rent_request_id
  LEFT JOIN alloc_activity aa ON aa.rent_request_id = ar.rent_request_id
  LEFT JOIN reversed rv ON rv.rent_request_id = ar.rent_request_id
  LEFT JOIN paused pz ON pz.rent_request_id = ar.rent_request_id
  LEFT JOIN landlord_settled ls ON ls.rent_request_id = ar.rent_request_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS open_allocs
    FROM public.agent_landlord_float_allocations oa_1
    WHERE oa_1.rent_request_id = ar.rent_request_id
      AND oa_1.status IN ('open','partially_paid','return_pending')
  ) oa ON true
  WHERE (rv.rent_request_id IS NULL OR COALESCE(pp.paid_before_today,0) > 0)
    AND pz.rent_request_id IS NULL
    AND (COALESCE(ar.total_repayment,0) - COALESCE(ar.amount_repaid,0)) > 0
    AND (COALESCE(pp.paid_before_today,0) > 0
         OR ((ar.funded_at IS NULL OR ar.funded_at < ds.ts)
             AND (aa.last_change IS NULL OR aa.last_change < ds.ts)
             AND (ls.rent_request_id IS NOT NULL OR COALESCE(oa.open_allocs,0) = 0)))
),
weekly_stats AS (
  SELECT lr.agent_id,
         count(*)::int                                   AS weekly_plan_count,
         count(*) FILTER (WHERE lr.weekly_lapsed)::int   AS weekly_lapsed_count,
         COALESCE(sum(COALESCE(lr.daily_repayment,0) * 7),0) AS weekly_expected_week
  FROM live_rents lr
  WHERE lr.is_weekly
  GROUP BY lr.agent_id
),
-- The daily gate: daily plans, plus weekly plans whose week lapsed unpaid
eligible_rents AS (
  SELECT lr.agent_id,
         lr.rent_request_id,
         lr.tenant_id,
         COALESCE(lr.daily_repayment,0) AS daily_repayment,
         COALESCE(lr.daily_repayment,0) AS due_today_amount,
         COALESCE(lr.daily_repayment,0) AS due_yesterday_amount,
         true AS due_today,
         true AS due_yesterday
  FROM live_rents lr
  WHERE NOT lr.is_weekly OR lr.weekly_lapsed
),
expected AS (
  SELECT er.agent_id,
         count(*)::int AS active_count,
         COALESCE(sum(er.due_today_amount),0)     AS expected_daily,
         COALESCE(sum(er.due_yesterday_amount),0) AS expected_yesterday,
         count(*) FILTER (WHERE er.due_today)::int     AS due_today_count,
         count(*) FILTER (WHERE er.due_yesterday)::int AS due_yesterday_count
  FROM eligible_rents er
  GROUP BY er.agent_id
),
agents AS (
  SELECT agent_id FROM expected
  UNION
  SELECT agent_id FROM weekly_stats
),
collection_events AS (
  SELECT ac.agent_id, ac.rent_request_id, ac.tenant_id, ac.amount,
         (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS day
  FROM public.agent_collections ac
  WHERE ac.created_at >= (((now() AT TIME ZONE 'Africa/Kampala')::date - 1)::timestamp AT TIME ZONE 'Africa/Kampala')
),
matched AS (
  SELECT er.agent_id, er.rent_request_id, er.due_today_amount, er.due_yesterday_amount,
         ce.day, sum(ce.amount) AS tenant_paid
  FROM eligible_rents er
  JOIN collection_events ce
    ON ce.agent_id = er.agent_id
   AND (ce.rent_request_id = er.rent_request_id
        OR (ce.rent_request_id IS NULL AND ce.tenant_id IS NOT NULL AND ce.tenant_id = er.tenant_id))
  GROUP BY er.agent_id, er.rent_request_id, er.due_today_amount, er.due_yesterday_amount, ce.day
),
per_day AS (
  SELECT m.agent_id, m.day,
         sum(LEAST(m.tenant_paid, GREATEST(
           CASE WHEN m.day = (SELECT d_today FROM day_start) THEN m.due_today_amount ELSE m.due_yesterday_amount END, 0))) AS capped_paid,
         count(*) FILTER (WHERE m.tenant_paid > 0 AND
           CASE WHEN m.day = (SELECT d_today FROM day_start) THEN m.due_today_amount ELSE m.due_yesterday_amount END > 0)::int AS tenants_paid
  FROM matched m
  GROUP BY m.agent_id, m.day
),
raw_collected AS (
  SELECT m.agent_id,
         sum(CASE WHEN m.day = (SELECT d_today FROM day_start) AND m.due_today_amount > 0 THEN m.tenant_paid ELSE 0 END) AS paid_today,
         sum(CASE WHEN m.day = (SELECT d_yesterday FROM day_start) AND m.due_yesterday_amount > 0 THEN m.tenant_paid ELSE 0 END) AS paid_yesterday
  FROM matched m
  GROUP BY m.agent_id
),
coverage AS (
  SELECT per_day.agent_id,
         COALESCE(sum(per_day.capped_paid) FILTER (WHERE per_day.day = (SELECT d_today FROM day_start)),0)     AS capped_paid_today,
         COALESCE(sum(per_day.capped_paid) FILTER (WHERE per_day.day = (SELECT d_yesterday FROM day_start)),0) AS capped_paid_yesterday,
         COALESCE(max(per_day.tenants_paid) FILTER (WHERE per_day.day = (SELECT d_today FROM day_start)),0)     AS tenants_paid_today,
         COALESCE(max(per_day.tenants_paid) FILTER (WHERE per_day.day = (SELECT d_yesterday FROM day_start)),0) AS tenants_paid_yesterday
  FROM per_day
  GROUP BY per_day.agent_id
)
SELECT a.agent_id,
       COALESCE(e.active_count,0)                 AS active_count,
       COALESCE(e.expected_daily,0)               AS expected_daily,
       COALESCE(rc.paid_today,0)                  AS paid_today,
       COALESCE(rc.paid_yesterday,0)              AS paid_yesterday,
       CASE WHEN COALESCE(e.expected_daily,0) > 0 THEN round(LEAST(COALESCE(cv.capped_paid_today,0), e.expected_daily) / e.expected_daily, 4) ELSE 1 END AS today_pct,
       CASE WHEN COALESCE(e.expected_yesterday,0) > 0 THEN round(LEAST(COALESCE(cv.capped_paid_yesterday,0), e.expected_yesterday) / e.expected_yesterday, 4) ELSE 1 END AS yesterday_pct,
       GREATEST(
         CASE WHEN COALESCE(e.expected_daily,0) > 0 THEN round(LEAST(COALESCE(cv.capped_paid_today,0), e.expected_daily) / e.expected_daily, 4) ELSE 1 END,
         CASE WHEN COALESCE(e.expected_yesterday,0) > 0 THEN round(LEAST(COALESCE(cv.capped_paid_yesterday,0), e.expected_yesterday) / e.expected_yesterday, 4) ELSE 1 END
       ) AS effective_pct,
       CASE WHEN COALESCE(e.expected_daily,0) > 0 THEN round(COALESCE(rc.paid_today,0) / e.expected_daily, 4) ELSE 0 END     AS raw_today_pct,
       CASE WHEN COALESCE(e.expected_yesterday,0) > 0 THEN round(COALESCE(rc.paid_yesterday,0) / e.expected_yesterday, 4) ELSE 0 END AS raw_yesterday_pct,
       COALESCE(e.due_today_count,0)              AS tenants_due,
       LEAST(COALESCE(cv.tenants_paid_today,0), COALESCE(e.due_today_count,0))         AS tenants_paid_today,
       LEAST(COALESCE(cv.tenants_paid_yesterday,0), COALESCE(e.due_yesterday_count,0)) AS tenants_paid_yesterday,
       CASE WHEN COALESCE(e.due_today_count,0) > 0 THEN round(LEAST(COALESCE(cv.tenants_paid_today,0), e.due_today_count)::numeric / e.due_today_count::numeric, 4) ELSE 1 END AS coverage_today,
       CASE WHEN COALESCE(e.due_yesterday_count,0) > 0 THEN round(LEAST(COALESCE(cv.tenants_paid_yesterday,0), e.due_yesterday_count)::numeric / e.due_yesterday_count::numeric, 4) ELSE 1 END AS coverage_yesterday,
       GREATEST(
         CASE WHEN COALESCE(e.due_today_count,0) > 0 THEN round(LEAST(COALESCE(cv.tenants_paid_today,0), e.due_today_count)::numeric / e.due_today_count::numeric, 4) ELSE 1 END,
         CASE WHEN COALESCE(e.due_yesterday_count,0) > 0 THEN round(LEAST(COALESCE(cv.tenants_paid_yesterday,0), e.due_yesterday_count)::numeric / e.due_yesterday_count::numeric, 4) ELSE 1 END
       ) AS effective_coverage,
       COALESCE(ws.weekly_plan_count,0)     AS weekly_plan_count,
       COALESCE(ws.weekly_lapsed_count,0)   AS weekly_lapsed_count,
       COALESCE(ws.weekly_expected_week,0)  AS weekly_expected_week
FROM agents a
LEFT JOIN expected e      USING (agent_id)
LEFT JOIN weekly_stats ws USING (agent_id)
LEFT JOIN raw_collected rc USING (agent_id)
LEFT JOIN coverage cv      USING (agent_id);

-- RPC: return type changes, so drop + recreate (same grants as before).
DROP FUNCTION IF EXISTS public.get_agent_daily_eligibility(uuid[]);
CREATE FUNCTION public.get_agent_daily_eligibility(p_agent_ids uuid[])
RETURNS TABLE(
  agent_id uuid, active_count integer, expected_daily numeric,
  paid_today numeric, paid_yesterday numeric,
  today_pct numeric, yesterday_pct numeric, effective_pct numeric,
  raw_today_pct numeric, raw_yesterday_pct numeric,
  tenants_due integer, tenants_paid_today integer, tenants_paid_yesterday integer,
  coverage_today numeric, coverage_yesterday numeric, effective_coverage numeric,
  weekly_plan_count integer, weekly_lapsed_count integer, weekly_expected_week numeric
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT v.agent_id, v.active_count, v.expected_daily,
         v.paid_today, v.paid_yesterday,
         v.today_pct, v.yesterday_pct, v.effective_pct,
         v.raw_today_pct, v.raw_yesterday_pct,
         v.tenants_due, v.tenants_paid_today, v.tenants_paid_yesterday,
         v.coverage_today, v.coverage_yesterday, v.effective_coverage,
         v.weekly_plan_count, v.weekly_lapsed_count, v.weekly_expected_week
  FROM public.v_agent_daily_eligibility v
  WHERE v.agent_id = ANY (p_agent_ids);
$function$;
GRANT EXECUTE ON FUNCTION public.get_agent_daily_eligibility(uuid[]) TO authenticated, anon, service_role;

-- Data correction: Mwaka Isaac's tenant (Joseph Matovu) pays weekly.
UPDATE public.rent_requests
SET repayment_frequency = 'weekly',
    repayment_starts_on = COALESCE(repayment_starts_on, DATE '2026-09-02')
WHERE id = '33e55b8f-802c-4fcb-bf2b-f04051e1ab37'
  AND lower(COALESCE(repayment_frequency,'daily')) <> 'weekly';

INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, description, metadata)
VALUES ('rent_request_created',
        '8853f6f4-df95-4659-9d3e-35294f0a83a2',
        'rent_request',
        '33e55b8f-802c-4fcb-bf2b-f04051e1ab37',
        'Repayment frequency corrected to weekly (tenant pays weekly); amounts unchanged',
        jsonb_build_object('change','repayment_frequency_corrected','from','daily','to','weekly',
                           'rent_request_id','33e55b8f-802c-4fcb-bf2b-f04051e1ab37',
                           'reason','Agent reported tenant pays weekly; weekly plans tracked separately from daily eligibility'));