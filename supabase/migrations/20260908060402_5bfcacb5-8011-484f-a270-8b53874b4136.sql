CREATE OR REPLACE VIEW public.v_agent_daily_eligibility AS
WITH day_start AS (
  SELECT ((now() AT TIME ZONE 'Africa/Kampala')::date::timestamp AT TIME ZONE 'Africa/Kampala') AS ts,
         (now() AT TIME ZONE 'Africa/Kampala')::date AS d_today,
         ((now() AT TIME ZONE 'Africa/Kampala')::date - 1) AS d_yesterday
), active_rents AS (
  SELECT rr.agent_id,
         rr.id AS rent_request_id,
         rr.tenant_id,
         rr.daily_repayment,
         rr.amount_repaid,
         rr.total_repayment,
         rr.funded_at,
         lower(COALESCE(rr.repayment_frequency, 'daily')) AS frequency,
         EXTRACT(DOW FROM COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date, rr.created_at::date))::int AS due_dow
    FROM rent_requests rr
   WHERE rr.status = ANY (ARRAY['funded'::text, 'repaying'::text])
     AND COALESCE(rr.agent_payment_status, 'paying') <> 'not_paying'
), prior_paid AS (
  SELECT ac.rent_request_id, sum(ac.amount) AS paid_before_today
    FROM agent_collections ac CROSS JOIN day_start ds
   WHERE ac.rent_request_id IS NOT NULL AND ac.created_at < ds.ts
   GROUP BY ac.rent_request_id
), paused AS (
  SELECT DISTINCT p.rent_request_id
    FROM rent_repayment_pauses p
   WHERE p.status = 'active' AND p.resumed_at IS NULL
     AND (p.resume_on IS NULL OR p.resume_on >= (now() AT TIME ZONE 'Africa/Kampala')::date)
), reversed AS (
  SELECT DISTINCT r.rent_request_id FROM agent_tenant_float_reversals r
), landlord_settled AS (
  SELECT DISTINCT a.rent_request_id
    FROM agent_landlord_float_allocations a
   WHERE a.rent_request_id IS NOT NULL AND a.paid_out_amount > 0::numeric
), alloc_activity AS (
  SELECT a.rent_request_id, max(GREATEST(a.created_at, COALESCE(a.updated_at, a.created_at))) AS last_change
    FROM agent_landlord_float_allocations a
   WHERE a.rent_request_id IS NOT NULL
   GROUP BY a.rent_request_id
), eligible_rents AS (
  SELECT ar.agent_id,
         ar.rent_request_id,
         ar.tenant_id,
         ar.frequency,
         ar.due_dow,
         COALESCE(ar.daily_repayment, 0::numeric) AS daily_repayment,
         /* Weekly plans are expected only on their own collection weekday,
            and then for the whole week's worth. */
         CASE
           WHEN ar.frequency = 'weekly' THEN
             CASE WHEN ar.due_dow = EXTRACT(DOW FROM ds.d_today)::int
                  THEN COALESCE(ar.daily_repayment, 0::numeric) * 7 ELSE 0::numeric END
           ELSE COALESCE(ar.daily_repayment, 0::numeric)
         END AS due_today_amount,
         CASE
           WHEN ar.frequency = 'weekly' THEN
             CASE WHEN ar.due_dow = EXTRACT(DOW FROM ds.d_yesterday)::int
                  THEN COALESCE(ar.daily_repayment, 0::numeric) * 7 ELSE 0::numeric END
           ELSE COALESCE(ar.daily_repayment, 0::numeric)
         END AS due_yesterday_amount,
         (ar.frequency <> 'weekly' OR ar.due_dow = EXTRACT(DOW FROM ds.d_today)::int) AS due_today,
         (ar.frequency <> 'weekly' OR ar.due_dow = EXTRACT(DOW FROM ds.d_yesterday)::int) AS due_yesterday
    FROM active_rents ar
    CROSS JOIN day_start ds
    LEFT JOIN prior_paid pp ON pp.rent_request_id = ar.rent_request_id
    LEFT JOIN alloc_activity aa ON aa.rent_request_id = ar.rent_request_id
    LEFT JOIN reversed rv ON rv.rent_request_id = ar.rent_request_id
    LEFT JOIN paused pz ON pz.rent_request_id = ar.rent_request_id
    LEFT JOIN landlord_settled ls ON ls.rent_request_id = ar.rent_request_id
    LEFT JOIN LATERAL (
      SELECT count(*) AS open_allocs
        FROM agent_landlord_float_allocations oa_1
       WHERE oa_1.rent_request_id = ar.rent_request_id
         AND oa_1.status = ANY (ARRAY['open'::text, 'partially_paid'::text, 'return_pending'::text])
    ) oa ON true
   WHERE (rv.rent_request_id IS NULL OR COALESCE(pp.paid_before_today, 0::numeric) > 0::numeric)
     AND pz.rent_request_id IS NULL
     AND (COALESCE(ar.total_repayment, 0::numeric) - COALESCE(ar.amount_repaid, 0::numeric)) > 0::numeric
     AND (COALESCE(pp.paid_before_today, 0::numeric) > 0::numeric
          OR (ar.funded_at IS NULL OR ar.funded_at < ds.ts)
             AND (aa.last_change IS NULL OR aa.last_change < ds.ts)
             AND (ls.rent_request_id IS NOT NULL OR COALESCE(oa.open_allocs, 0::bigint) = 0))
), expected AS (
  SELECT er.agent_id,
         count(*)::integer AS active_count,
         COALESCE(sum(er.due_today_amount), 0::numeric) AS expected_daily,
         COALESCE(sum(er.due_yesterday_amount), 0::numeric) AS expected_yesterday,
         count(*) FILTER (WHERE er.due_today)::integer AS due_today_count,
         count(*) FILTER (WHERE er.due_yesterday)::integer AS due_yesterday_count
    FROM eligible_rents er
   GROUP BY er.agent_id
), collection_events AS (
  SELECT ac.agent_id, ac.rent_request_id, ac.tenant_id, ac.amount,
         (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS day
    FROM agent_collections ac
   WHERE ac.created_at >= (((now() AT TIME ZONE 'Africa/Kampala')::date - 1)::timestamp AT TIME ZONE 'Africa/Kampala')
), matched AS (
  SELECT er.agent_id,
         er.rent_request_id,
         er.due_today_amount,
         er.due_yesterday_amount,
         ce.day,
         sum(ce.amount) AS tenant_paid
    FROM eligible_rents er
    JOIN collection_events ce
      ON ce.agent_id = er.agent_id
     AND (ce.rent_request_id = er.rent_request_id
          OR ce.rent_request_id IS NULL AND ce.tenant_id IS NOT NULL AND ce.tenant_id = er.tenant_id)
   GROUP BY er.agent_id, er.rent_request_id, er.due_today_amount, er.due_yesterday_amount, ce.day
), per_day AS (
  SELECT m.agent_id,
         m.day,
         sum(LEAST(m.tenant_paid, GREATEST(
           CASE WHEN m.day = (SELECT d_today FROM day_start) THEN m.due_today_amount
                ELSE m.due_yesterday_amount END, 0::numeric))) AS capped_paid,
         count(*) FILTER (
           WHERE m.tenant_paid > 0::numeric
             AND (CASE WHEN m.day = (SELECT d_today FROM day_start) THEN m.due_today_amount
                       ELSE m.due_yesterday_amount END) > 0::numeric
         )::integer AS tenants_paid
    FROM matched m
   GROUP BY m.agent_id, m.day
), raw_collected AS (
  /* Raw daily totals exclude weekly tenants collected outside their own day. */
  SELECT m.agent_id,
         sum(CASE WHEN m.day = (SELECT d_today FROM day_start) AND m.due_today_amount > 0 THEN m.tenant_paid ELSE 0 END) AS paid_today,
         sum(CASE WHEN m.day = (SELECT d_yesterday FROM day_start) AND m.due_yesterday_amount > 0 THEN m.tenant_paid ELSE 0 END) AS paid_yesterday
    FROM matched m
   GROUP BY m.agent_id
), coverage AS (
  SELECT per_day.agent_id,
         COALESCE(sum(per_day.capped_paid) FILTER (WHERE per_day.day = (SELECT d_today FROM day_start)), 0::numeric) AS capped_paid_today,
         COALESCE(sum(per_day.capped_paid) FILTER (WHERE per_day.day = (SELECT d_yesterday FROM day_start)), 0::numeric) AS capped_paid_yesterday,
         COALESCE(max(per_day.tenants_paid) FILTER (WHERE per_day.day = (SELECT d_today FROM day_start)), 0) AS tenants_paid_today,
         COALESCE(max(per_day.tenants_paid) FILTER (WHERE per_day.day = (SELECT d_yesterday FROM day_start)), 0) AS tenants_paid_yesterday
    FROM per_day
   GROUP BY per_day.agent_id
)
SELECT e.agent_id,
       e.active_count,
       e.expected_daily,
       COALESCE(rc.paid_today, 0::numeric) AS paid_today,
       COALESCE(rc.paid_yesterday, 0::numeric) AS paid_yesterday,
       CASE WHEN e.expected_daily > 0::numeric
            THEN round(LEAST(COALESCE(cv.capped_paid_today, 0::numeric), e.expected_daily) / e.expected_daily, 4)
            ELSE 1::numeric END AS today_pct,
       CASE WHEN e.expected_yesterday > 0::numeric
            THEN round(LEAST(COALESCE(cv.capped_paid_yesterday, 0::numeric), e.expected_yesterday) / e.expected_yesterday, 4)
            ELSE 1::numeric END AS yesterday_pct,
       GREATEST(
         CASE WHEN e.expected_daily > 0::numeric
              THEN round(LEAST(COALESCE(cv.capped_paid_today, 0::numeric), e.expected_daily) / e.expected_daily, 4)
              ELSE 1::numeric END,
         CASE WHEN e.expected_yesterday > 0::numeric
              THEN round(LEAST(COALESCE(cv.capped_paid_yesterday, 0::numeric), e.expected_yesterday) / e.expected_yesterday, 4)
              ELSE 1::numeric END
       ) AS effective_pct,
       CASE WHEN e.expected_daily > 0::numeric
            THEN round(COALESCE(rc.paid_today, 0::numeric) / e.expected_daily, 4) ELSE 0::numeric END AS raw_today_pct,
       CASE WHEN e.expected_yesterday > 0::numeric
            THEN round(COALESCE(rc.paid_yesterday, 0::numeric) / e.expected_yesterday, 4) ELSE 0::numeric END AS raw_yesterday_pct,
       e.due_today_count AS tenants_due,
       LEAST(COALESCE(cv.tenants_paid_today, 0), e.due_today_count) AS tenants_paid_today,
       LEAST(COALESCE(cv.tenants_paid_yesterday, 0), e.due_yesterday_count) AS tenants_paid_yesterday,
       CASE WHEN e.due_today_count > 0
            THEN round(LEAST(COALESCE(cv.tenants_paid_today, 0), e.due_today_count)::numeric / e.due_today_count::numeric, 4)
            ELSE 1::numeric END AS coverage_today,
       CASE WHEN e.due_yesterday_count > 0
            THEN round(LEAST(COALESCE(cv.tenants_paid_yesterday, 0), e.due_yesterday_count)::numeric / e.due_yesterday_count::numeric, 4)
            ELSE 1::numeric END AS coverage_yesterday,
       GREATEST(
         CASE WHEN e.due_today_count > 0
              THEN round(LEAST(COALESCE(cv.tenants_paid_today, 0), e.due_today_count)::numeric / e.due_today_count::numeric, 4)
              ELSE 1::numeric END,
         CASE WHEN e.due_yesterday_count > 0
              THEN round(LEAST(COALESCE(cv.tenants_paid_yesterday, 0), e.due_yesterday_count)::numeric / e.due_yesterday_count::numeric, 4)
              ELSE 1::numeric END
       ) AS effective_coverage
  FROM expected e
  LEFT JOIN raw_collected rc USING (agent_id)
  LEFT JOIN coverage cv USING (agent_id);