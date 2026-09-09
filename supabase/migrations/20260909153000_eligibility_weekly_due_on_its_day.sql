-- Weekly plans now appear in the daily target ON THEIR DUE DAY, and count then.
--
-- Prior behaviour: `eligible_rents` filtered `WHERE NOT lr.is_weekly OR
-- lr.weekly_lapsed`, so a healthy weekly plan was excluded from the daily
-- picture entirely — no target contribution AND no credit for its collections,
-- because `matched` INNER JOINs from `eligible_rents`.
--
-- The worst case measured 2026-09-09: an agent whose only plan is weekly showed
-- `expected_daily = 0` and `paid_today = 0`, while his real bill that day was
-- 330,519 and he had collected 163,000. Worse, the view returns
-- `today_pct = 1` when the target is zero, so he was silently AUTO-PASSING the
-- daily gate rather than being measured at all.
--
-- Change, in `eligible_rents` only:
--   * `due_today_amount` / `due_yesterday_amount` for a non-lapsed weekly plan
--     come from the pinned bill for that day (`agent_expected_day_plans`), which
--     already resolves frequency correctly — `rent_plan_schedule_days` collapses
--     a weekly plan into one instalment of `daily_amount * 7` on its due date.
--   * `due_today` / `due_yesterday` become "was it billed that day" for those
--     plans, instead of hardcoded true.
--   * A weekly plan is admitted when it was billed today or yesterday.
--
-- Daily plans are untouched: they keep `daily_repayment` on both days and stay
-- unconditionally admitted.
--
-- `weekly_lapsed` semantics are deliberately preserved. A lapsed weekly plan
-- (past its first week with no collection in 7 days) still falls back to the
-- daily rate and stays admitted, so the existing penalty for a weekly tenant
-- who has gone quiet is unchanged. Only NON-lapsed weekly plans switch to the
-- bill-driven figure.
--
-- Measured effect — 3 agents, all with weekly plans:
--
--   agent               target before -> after
--   MWAKA ISAAC                0 -> 330,519   (and paid_today 0 -> 163,000, 49.3%)
--   Martin lukwago        53,687 -> 166,464
--   Mugisha Emmanuel     325,224 -> 339,191
--
-- KNOWN CONSEQUENCE, accepted deliberately: an agent holding only weekly plans
-- previously passed the daily gate for free (zero target -> today_pct = 1). He
-- is now genuinely measured, so he can fall below the unlock threshold. MWAKA
-- ISAAC sits at 49.3% against a 50% threshold and would be blocked from posting
-- new rents until he collects more. This is the intended behaviour, not a
-- regression, but it is a tightening for that population.
--
-- Also by design: a collection on a weekly plan on a day it was NOT billed does
-- not count toward that day's target. It becomes arrears, exactly as an early or
-- late payment on a daily plan does. Verified remaining gaps after this change
-- are only (a) that case and (b) the one plan whose schedule was never pinned
-- (39976d4a, weekly, start date equal to its funding day).
--
-- Builds on 20260909152000 (a plan settled today stays in today's picture);
-- both changes are present in this definition. Column list and order unchanged,
-- as CREATE OR REPLACE VIEW requires.

CREATE OR REPLACE VIEW public.v_agent_daily_eligibility AS
 WITH day_start AS (
         SELECT ((now() AT TIME ZONE 'Africa/Kampala'::text)::date::timestamp without time zone AT TIME ZONE 'Africa/Kampala'::text) AS ts,
            (now() AT TIME ZONE 'Africa/Kampala'::text)::date AS d_today,
            (now() AT TIME ZONE 'Africa/Kampala'::text)::date - 1 AS d_yesterday,
            (((now() AT TIME ZONE 'Africa/Kampala'::text)::date - 6)::timestamp without time zone AT TIME ZONE 'Africa/Kampala'::text) AS week_ts
        ), all_rents AS (
         SELECT rr.agent_id,
            rr.id AS rent_request_id,
            rr.tenant_id,
            rr.daily_repayment,
            rr.amount_repaid,
            rr.total_repayment,
            rr.funded_at,
            COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala'::text)::date) AS starts_on,
            lower(COALESCE(rr.repayment_frequency, 'daily'::text)) = 'weekly'::text OR rent_request_is_weekly_shape(rr.duration_days, rr.registration_type) AS is_weekly
           FROM rent_requests rr
          WHERE ((rr.status = ANY (ARRAY['funded'::text, 'repaying'::text])) OR rr.status = 'completed'::text AND (EXISTS ( SELECT 1
                   FROM agent_collections ac0
                  WHERE ac0.amount > 0::numeric AND ac0.created_at >= ((now() AT TIME ZONE 'Africa/Kampala'::text)::date::timestamp without time zone AT TIME ZONE 'Africa/Kampala'::text) AND (ac0.rent_request_id = rr.id OR ac0.rent_request_id IS NULL AND ac0.tenant_id IS NOT NULL AND ac0.tenant_id = rr.tenant_id)))) AND COALESCE(rr.agent_payment_status, 'paying'::text) <> 'not_paying'::text
        ), week_paid AS (
         SELECT ar.rent_request_id
           FROM all_rents ar
             CROSS JOIN day_start ds
          WHERE ar.is_weekly AND (EXISTS ( SELECT 1
                   FROM agent_collections ac
                  WHERE ac.created_at >= ds.week_ts AND ac.amount > 0::numeric AND (ac.rent_request_id = ar.rent_request_id OR ac.rent_request_id IS NULL AND ac.tenant_id IS NOT NULL AND ac.tenant_id = ar.tenant_id)))
        ), active_rents AS (
         SELECT ar.agent_id,
            ar.rent_request_id,
            ar.tenant_id,
            ar.daily_repayment,
            ar.amount_repaid,
            ar.total_repayment,
            ar.funded_at,
            ar.starts_on,
            ar.is_weekly,
            ar.is_weekly AND ar.starts_on IS NOT NULL AND (ar.starts_on + 7) <= ds.d_today AND wp.rent_request_id IS NULL AS weekly_lapsed
           FROM all_rents ar
             CROSS JOIN day_start ds
             LEFT JOIN week_paid wp ON wp.rent_request_id = ar.rent_request_id
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
         SELECT DISTINCT r.rent_request_id
           FROM agent_tenant_float_reversals r
        UNION
         SELECT DISTINCT arr.rent_request_id
           FROM agent_allocation_return_requests arr
          WHERE arr.status = 'approved'::text AND arr.rent_request_id IS NOT NULL
        ), landlord_settled AS (
         SELECT DISTINCT a_1.rent_request_id
           FROM agent_landlord_float_allocations a_1
          WHERE a_1.rent_request_id IS NOT NULL AND a_1.paid_out_amount > 0::numeric
        ), alloc_activity AS (
         SELECT a_1.rent_request_id,
            max(GREATEST(a_1.created_at, COALESCE(a_1.updated_at, a_1.created_at))) AS last_change
           FROM agent_landlord_float_allocations a_1
          WHERE a_1.rent_request_id IS NOT NULL
          GROUP BY a_1.rent_request_id
        ), live_rents AS (
         SELECT ar.agent_id,
            ar.rent_request_id,
            ar.tenant_id,
            ar.daily_repayment,
            ar.amount_repaid,
            ar.total_repayment,
            ar.funded_at,
            ar.starts_on,
            ar.is_weekly,
            ar.weekly_lapsed
           FROM active_rents ar
             CROSS JOIN day_start ds
             LEFT JOIN prior_paid pp ON pp.rent_request_id = ar.rent_request_id
             LEFT JOIN alloc_activity aa ON aa.rent_request_id = ar.rent_request_id
             LEFT JOIN reversed rv ON rv.rent_request_id = ar.rent_request_id
             LEFT JOIN paused pz ON pz.rent_request_id = ar.rent_request_id
             LEFT JOIN landlord_settled ls ON ls.rent_request_id = ar.rent_request_id
             LEFT JOIN LATERAL ( SELECT count(*) AS open_allocs
                   FROM agent_landlord_float_allocations oa_1
                  WHERE oa_1.rent_request_id = ar.rent_request_id AND (oa_1.status = ANY (ARRAY['open'::text, 'partially_paid'::text, 'return_pending'::text]))) oa ON true
          WHERE (rv.rent_request_id IS NULL OR COALESCE(pp.paid_before_today, 0::numeric) > 0::numeric) AND pz.rent_request_id IS NULL AND ((COALESCE(ar.total_repayment, 0::numeric) - COALESCE(ar.amount_repaid, 0::numeric)) > 0::numeric OR (EXISTS ( SELECT 1
                   FROM agent_collections ac2
                  WHERE ac2.amount > 0::numeric AND ac2.created_at >= ds.ts AND (ac2.rent_request_id = ar.rent_request_id OR ac2.rent_request_id IS NULL AND ac2.tenant_id IS NOT NULL AND ac2.tenant_id = ar.tenant_id)))) AND (COALESCE(pp.paid_before_today, 0::numeric) > 0::numeric OR (ar.funded_at IS NULL OR ar.funded_at < ds.ts) AND (aa.last_change IS NULL OR aa.last_change < ds.ts) AND (ls.rent_request_id IS NOT NULL OR COALESCE(oa.open_allocs, 0::bigint) = 0))
        ), weekly_stats AS (
         SELECT lr.agent_id,
            count(*)::integer AS weekly_plan_count,
            count(*) FILTER (WHERE lr.weekly_lapsed)::integer AS weekly_lapsed_count,
            COALESCE(sum(COALESCE(lr.daily_repayment, 0::numeric) * 7::numeric), 0::numeric) AS weekly_expected_week
           FROM live_rents lr
          WHERE lr.is_weekly
          GROUP BY lr.agent_id
        ), eligible_rents AS (
         SELECT lr.agent_id,
            lr.rent_request_id,
            lr.tenant_id,
            COALESCE(lr.daily_repayment, 0::numeric) AS daily_repayment,
                CASE
                    WHEN lr.is_weekly AND NOT lr.weekly_lapsed THEN COALESCE(bill_t.expected_ugx, 0::numeric)
                    ELSE COALESCE(lr.daily_repayment, 0::numeric)
                END AS due_today_amount,
                CASE
                    WHEN lr.is_weekly AND NOT lr.weekly_lapsed THEN COALESCE(bill_y.expected_ugx, 0::numeric)
                    ELSE COALESCE(lr.daily_repayment, 0::numeric)
                END AS due_yesterday_amount,
                CASE
                    WHEN lr.is_weekly AND NOT lr.weekly_lapsed THEN bill_t.rent_request_id IS NOT NULL
                    ELSE true
                END AS due_today,
                CASE
                    WHEN lr.is_weekly AND NOT lr.weekly_lapsed THEN bill_y.rent_request_id IS NOT NULL
                    ELSE true
                END AS due_yesterday
           FROM live_rents lr
             CROSS JOIN day_start ds
             LEFT JOIN agent_expected_day_plans bill_t ON bill_t.rent_request_id = lr.rent_request_id AND bill_t.day = ds.d_today
             LEFT JOIN agent_expected_day_plans bill_y ON bill_y.rent_request_id = lr.rent_request_id AND bill_y.day = ds.d_yesterday
          WHERE NOT lr.is_weekly OR lr.weekly_lapsed OR bill_t.rent_request_id IS NOT NULL OR bill_y.rent_request_id IS NOT NULL
        ), expected AS (
         SELECT er.agent_id,
            count(*)::integer AS active_count,
            COALESCE(sum(er.due_today_amount), 0::numeric) AS expected_daily,
            COALESCE(sum(er.due_yesterday_amount), 0::numeric) AS expected_yesterday,
            count(*) FILTER (WHERE er.due_today)::integer AS due_today_count,
            count(*) FILTER (WHERE er.due_yesterday)::integer AS due_yesterday_count
           FROM eligible_rents er
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
            (ac.created_at AT TIME ZONE 'Africa/Kampala'::text)::date AS day
           FROM agent_collections ac
          WHERE ac.created_at >= (((now() AT TIME ZONE 'Africa/Kampala'::text)::date - 1)::timestamp without time zone AT TIME ZONE 'Africa/Kampala'::text)
        ), matched AS (
         SELECT er.agent_id,
            er.rent_request_id,
            er.due_today_amount,
            er.due_yesterday_amount,
            ce.day,
            sum(ce.amount) AS tenant_paid
           FROM eligible_rents er
             JOIN collection_events ce ON ce.agent_id = er.agent_id AND (ce.rent_request_id = er.rent_request_id OR ce.rent_request_id IS NULL AND ce.tenant_id IS NOT NULL AND ce.tenant_id = er.tenant_id)
          GROUP BY er.agent_id, er.rent_request_id, er.due_today_amount, er.due_yesterday_amount, ce.day
        ), per_day AS (
         SELECT m.agent_id,
            m.day,
            sum(LEAST(m.tenant_paid, GREATEST(
                CASE
                    WHEN m.day = (( SELECT day_start.d_today
                       FROM day_start)) THEN m.due_today_amount
                    ELSE m.due_yesterday_amount
                END, 0::numeric))) AS capped_paid,
            count(*) FILTER (WHERE m.tenant_paid > 0::numeric AND
                CASE
                    WHEN m.day = (( SELECT day_start.d_today
                       FROM day_start)) THEN m.due_today_amount
                    ELSE m.due_yesterday_amount
                END > 0::numeric)::integer AS tenants_paid
           FROM matched m
          GROUP BY m.agent_id, m.day
        ), raw_collected AS (
         SELECT m.agent_id,
            sum(
                CASE
                    WHEN m.day = (( SELECT day_start.d_today
                       FROM day_start)) AND m.due_today_amount > 0::numeric THEN m.tenant_paid
                    ELSE 0::numeric
                END) AS paid_today,
            sum(
                CASE
                    WHEN m.day = (( SELECT day_start.d_yesterday
                       FROM day_start)) AND m.due_yesterday_amount > 0::numeric THEN m.tenant_paid
                    ELSE 0::numeric
                END) AS paid_yesterday
           FROM matched m
          GROUP BY m.agent_id
        ), coverage AS (
         SELECT per_day.agent_id,
            COALESCE(sum(per_day.capped_paid) FILTER (WHERE per_day.day = (( SELECT day_start.d_today
                   FROM day_start))), 0::numeric) AS capped_paid_today,
            COALESCE(sum(per_day.capped_paid) FILTER (WHERE per_day.day = (( SELECT day_start.d_yesterday
                   FROM day_start))), 0::numeric) AS capped_paid_yesterday,
            COALESCE(max(per_day.tenants_paid) FILTER (WHERE per_day.day = (( SELECT day_start.d_today
                   FROM day_start))), 0) AS tenants_paid_today,
            COALESCE(max(per_day.tenants_paid) FILTER (WHERE per_day.day = (( SELECT day_start.d_yesterday
                   FROM day_start))), 0) AS tenants_paid_yesterday
           FROM per_day
          GROUP BY per_day.agent_id
        )
 SELECT a.agent_id,
    COALESCE(e.active_count, 0) AS active_count,
    COALESCE(e.expected_daily, 0::numeric) AS expected_daily,
    COALESCE(rc.paid_today, 0::numeric) AS paid_today,
    COALESCE(rc.paid_yesterday, 0::numeric) AS paid_yesterday,
        CASE
            WHEN COALESCE(e.expected_daily, 0::numeric) > 0::numeric THEN round(LEAST(COALESCE(cv.capped_paid_today, 0::numeric), e.expected_daily) / e.expected_daily, 4)
            ELSE 1::numeric
        END AS today_pct,
        CASE
            WHEN COALESCE(e.expected_yesterday, 0::numeric) > 0::numeric THEN round(LEAST(COALESCE(cv.capped_paid_yesterday, 0::numeric), e.expected_yesterday) / e.expected_yesterday, 4)
            ELSE 1::numeric
        END AS yesterday_pct,
    GREATEST(
        CASE
            WHEN COALESCE(e.expected_daily, 0::numeric) > 0::numeric THEN round(LEAST(COALESCE(cv.capped_paid_today, 0::numeric), e.expected_daily) / e.expected_daily, 4)
            ELSE 1::numeric
        END,
        CASE
            WHEN COALESCE(e.expected_yesterday, 0::numeric) > 0::numeric THEN round(LEAST(COALESCE(cv.capped_paid_yesterday, 0::numeric), e.expected_yesterday) / e.expected_yesterday, 4)
            ELSE 1::numeric
        END) AS effective_pct,
        CASE
            WHEN COALESCE(e.expected_daily, 0::numeric) > 0::numeric THEN round(COALESCE(rc.paid_today, 0::numeric) / e.expected_daily, 4)
            ELSE 0::numeric
        END AS raw_today_pct,
        CASE
            WHEN COALESCE(e.expected_yesterday, 0::numeric) > 0::numeric THEN round(COALESCE(rc.paid_yesterday, 0::numeric) / e.expected_yesterday, 4)
            ELSE 0::numeric
        END AS raw_yesterday_pct,
    COALESCE(e.due_today_count, 0) AS tenants_due,
    LEAST(COALESCE(cv.tenants_paid_today, 0), COALESCE(e.due_today_count, 0)) AS tenants_paid_today,
    LEAST(COALESCE(cv.tenants_paid_yesterday, 0), COALESCE(e.due_yesterday_count, 0)) AS tenants_paid_yesterday,
        CASE
            WHEN COALESCE(e.due_today_count, 0) > 0 THEN round(LEAST(COALESCE(cv.tenants_paid_today, 0), e.due_today_count)::numeric / e.due_today_count::numeric, 4)
            ELSE 1::numeric
        END AS coverage_today,
        CASE
            WHEN COALESCE(e.due_yesterday_count, 0) > 0 THEN round(LEAST(COALESCE(cv.tenants_paid_yesterday, 0), e.due_yesterday_count)::numeric / e.due_yesterday_count::numeric, 4)
            ELSE 1::numeric
        END AS coverage_yesterday,
    GREATEST(
        CASE
            WHEN COALESCE(e.due_today_count, 0) > 0 THEN round(LEAST(COALESCE(cv.tenants_paid_today, 0), e.due_today_count)::numeric / e.due_today_count::numeric, 4)
            ELSE 1::numeric
        END,
        CASE
            WHEN COALESCE(e.due_yesterday_count, 0) > 0 THEN round(LEAST(COALESCE(cv.tenants_paid_yesterday, 0), e.due_yesterday_count)::numeric / e.due_yesterday_count::numeric, 4)
            ELSE 1::numeric
        END) AS effective_coverage,
    COALESCE(ws.weekly_plan_count, 0) AS weekly_plan_count,
    COALESCE(ws.weekly_lapsed_count, 0) AS weekly_lapsed_count,
    COALESCE(ws.weekly_expected_week, 0::numeric) AS weekly_expected_week
   FROM agents a
     LEFT JOIN expected e USING (agent_id)
     LEFT JOIN weekly_stats ws USING (agent_id)
     LEFT JOIN raw_collected rc USING (agent_id)
     LEFT JOIN coverage cv USING (agent_id);
