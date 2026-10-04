CREATE OR REPLACE VIEW public.v_agent_daily_eligibility AS
WITH day_start AS (
         SELECT (((now() AT TIME ZONE 'Africa/Kampala'::text)::date)::timestamp without time zone AT TIME ZONE 'Africa/Kampala'::text) AS ts
        ), active_rents AS (
         SELECT rr.agent_id,
            rr.id AS rent_request_id,
            rr.tenant_id,
            rr.daily_repayment,
            rr.amount_repaid,
            rr.total_repayment,
            rr.funded_at
           FROM rent_requests rr
          WHERE (rr.status = ANY (ARRAY['funded'::text, 'repaying'::text])) AND COALESCE(rr.agent_payment_status, 'paying'::text) <> 'not_paying'::text
        ), prior_paid AS (
         SELECT ac.rent_request_id,
            sum(ac.amount) AS paid_before_today
           FROM agent_collections ac
          CROSS JOIN day_start ds
          WHERE ac.rent_request_id IS NOT NULL AND ac.created_at < ds.ts
          GROUP BY ac.rent_request_id
        ), paused AS (
         SELECT DISTINCT p.rent_request_id
           FROM rent_repayment_pauses p
          WHERE p.status = 'active'::text AND p.resumed_at IS NULL AND (p.resume_on IS NULL OR p.resume_on >= (now() AT TIME ZONE 'Africa/Kampala'::text)::date)
        ), reversed AS (
         SELECT DISTINCT agent_tenant_float_reversals.rent_request_id
           FROM agent_tenant_float_reversals
        ), landlord_settled AS (
         SELECT DISTINCT a.rent_request_id
           FROM agent_landlord_float_allocations a
          WHERE a.rent_request_id IS NOT NULL AND a.paid_out_amount > 0::numeric
        ), eligible_rents AS (
         SELECT ar.agent_id,
            ar.rent_request_id,
            ar.tenant_id,
            COALESCE(ar.daily_repayment, 0::numeric) AS daily_repayment
           FROM active_rents ar
             CROSS JOIN day_start ds
             LEFT JOIN prior_paid pp ON pp.rent_request_id = ar.rent_request_id
             LEFT JOIN reversed rv ON rv.rent_request_id = ar.rent_request_id
             LEFT JOIN paused pz ON pz.rent_request_id = ar.rent_request_id
             LEFT JOIN landlord_settled ls ON ls.rent_request_id = ar.rent_request_id
             LEFT JOIN LATERAL ( SELECT count(*) AS open_allocs
                   FROM agent_landlord_float_allocations oa_1
                  WHERE oa_1.rent_request_id = ar.rent_request_id AND (oa_1.status = ANY (ARRAY['open'::text, 'partially_paid'::text, 'return_pending'::text]))) oa ON true
          WHERE (ar.funded_at IS NULL OR ar.funded_at < ds.ts)
            AND (rv.rent_request_id IS NULL OR COALESCE(pp.paid_before_today, 0::numeric) > 0::numeric)
            AND pz.rent_request_id IS NULL
            AND (COALESCE(ar.total_repayment, 0::numeric) - COALESCE(ar.amount_repaid, 0::numeric)) > 0::numeric
            AND (ls.rent_request_id IS NOT NULL OR COALESCE(pp.paid_before_today, 0::numeric) > 0::numeric OR COALESCE(oa.open_allocs, 0::bigint) = 0)
        ), expected AS (
         SELECT eligible_rents.agent_id,
            count(*)::integer AS active_count,
            COALESCE(sum(eligible_rents.daily_repayment), 0::numeric) AS expected_daily
           FROM eligible_rents
          GROUP BY eligible_rents.agent_id
        ), collection_events AS (
         SELECT ac.agent_id,
            ac.rent_request_id,
            ac.tenant_id,
            ac.amount,
            (ac.created_at AT TIME ZONE 'Africa/Kampala'::text)::date AS day
           FROM agent_collections ac
          WHERE ac.created_at >= (((now() AT TIME ZONE 'Africa/Kampala'::text)::date - 1)::timestamp without time zone AT TIME ZONE 'Africa/Kampala'::text)
        ), collected AS (
         SELECT ce.agent_id,
            sum(
                CASE
                    WHEN ce.day = (now() AT TIME ZONE 'Africa/Kampala'::text)::date THEN ce.amount
                    ELSE 0::numeric
                END) AS paid_today,
            sum(
                CASE
                    WHEN ce.day = ((now() AT TIME ZONE 'Africa/Kampala'::text)::date - 1) THEN ce.amount
                    ELSE 0::numeric
                END) AS paid_yesterday
           FROM collection_events ce
          GROUP BY ce.agent_id
        ), matched AS (
         SELECT er.agent_id,
            er.rent_request_id,
            er.daily_repayment,
            ce.day,
            sum(ce.amount) AS tenant_paid
           FROM eligible_rents er
             JOIN collection_events ce ON ce.agent_id = er.agent_id AND (ce.rent_request_id = er.rent_request_id OR ce.rent_request_id IS NULL AND ce.tenant_id IS NOT NULL AND ce.tenant_id = er.tenant_id)
          GROUP BY er.agent_id, er.rent_request_id, er.daily_repayment, ce.day
        ), per_day AS (
         SELECT m.agent_id,
            m.day,
            sum(LEAST(m.tenant_paid, GREATEST(m.daily_repayment, 0::numeric))) AS capped_paid,
            count(*) FILTER (WHERE m.tenant_paid > 0::numeric)::integer AS tenants_paid
           FROM matched m
          GROUP BY m.agent_id, m.day
        ), coverage AS (
         SELECT per_day.agent_id,
            COALESCE(sum(per_day.capped_paid) FILTER (WHERE per_day.day = (now() AT TIME ZONE 'Africa/Kampala'::text)::date), 0::numeric) AS capped_paid_today,
            COALESCE(sum(per_day.capped_paid) FILTER (WHERE per_day.day = ((now() AT TIME ZONE 'Africa/Kampala'::text)::date - 1)), 0::numeric) AS capped_paid_yesterday,
            COALESCE(max(per_day.tenants_paid) FILTER (WHERE per_day.day = (now() AT TIME ZONE 'Africa/Kampala'::text)::date), 0) AS tenants_paid_today,
            COALESCE(max(per_day.tenants_paid) FILTER (WHERE per_day.day = ((now() AT TIME ZONE 'Africa/Kampala'::text)::date - 1)), 0) AS tenants_paid_yesterday
           FROM per_day
          GROUP BY per_day.agent_id
        )
 SELECT e.agent_id,
    e.active_count,
    e.expected_daily,
    COALESCE(c.paid_today, 0::numeric) AS paid_today,
    COALESCE(c.paid_yesterday, 0::numeric) AS paid_yesterday,
        CASE
            WHEN e.expected_daily > 0::numeric THEN round(LEAST(COALESCE(cv.capped_paid_today, 0::numeric), e.expected_daily) / e.expected_daily, 4)
            ELSE 0::numeric
        END AS today_pct,
        CASE
            WHEN e.expected_daily > 0::numeric THEN round(LEAST(COALESCE(cv.capped_paid_yesterday, 0::numeric), e.expected_daily) / e.expected_daily, 4)
            ELSE 0::numeric
        END AS yesterday_pct,
        CASE
            WHEN e.expected_daily > 0::numeric THEN round(GREATEST(LEAST(COALESCE(cv.capped_paid_today, 0::numeric), e.expected_daily), LEAST(COALESCE(cv.capped_paid_yesterday, 0::numeric), e.expected_daily)) / e.expected_daily, 4)
            ELSE 0::numeric
        END AS effective_pct,
        CASE
            WHEN e.expected_daily > 0::numeric THEN round(COALESCE(c.paid_today, 0::numeric) / e.expected_daily, 4)
            ELSE 0::numeric
        END AS raw_today_pct,
        CASE
            WHEN e.expected_daily > 0::numeric THEN round(COALESCE(c.paid_yesterday, 0::numeric) / e.expected_daily, 4)
            ELSE 0::numeric
        END AS raw_yesterday_pct,
    e.active_count AS tenants_due,
    LEAST(COALESCE(cv.tenants_paid_today, 0), e.active_count) AS tenants_paid_today,
    LEAST(COALESCE(cv.tenants_paid_yesterday, 0), e.active_count) AS tenants_paid_yesterday,
        CASE
            WHEN e.active_count > 0 THEN round(LEAST(COALESCE(cv.tenants_paid_today, 0), e.active_count)::numeric / e.active_count::numeric, 4)
            ELSE 0::numeric
        END AS coverage_today,
        CASE
            WHEN e.active_count > 0 THEN round(LEAST(COALESCE(cv.tenants_paid_yesterday, 0), e.active_count)::numeric / e.active_count::numeric, 4)
            ELSE 0::numeric
        END AS coverage_yesterday,
        CASE
            WHEN e.active_count > 0 THEN round(GREATEST(LEAST(COALESCE(cv.tenants_paid_today, 0), e.active_count), LEAST(COALESCE(cv.tenants_paid_yesterday, 0), e.active_count))::numeric / e.active_count::numeric, 4)
            ELSE 0::numeric
        END AS effective_coverage
   FROM expected e
     LEFT JOIN collected c USING (agent_id)
     LEFT JOIN coverage cv USING (agent_id);