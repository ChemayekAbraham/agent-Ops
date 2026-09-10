-- Agent daily eligibility: score against the pinned bill, not every plan's daily rate.
--
-- THE BUG
-- `v_agent_daily_eligibility` computed the agent's daily target as
--     SUM(rr.daily_repayment) over every live plan
-- and never referenced `agent_expected_day_plans` — the pinned bill — at all.
-- So an agent was charged for every tenant on their book, including plans that
-- owed nothing today: weekly plans between due dates, plans past their cycle,
-- plans not yet started.
--
-- Measured on agent Mugisha Emmanuel, 9 September 2026:
--     target shown            325,224   (22 "tenants due")
--     actual pinned bill       91,668   (5 plans billed)
--     collected that day      102,000
-- He was shown as 7% of target and told to collect 138,612 more to unlock
-- posting, while he had in fact collected more than the day's real bill.
--
-- This is the same 3.5x inflation removed from the Agent Ops reports and from
-- `agent_expected_collection` earlier. This view was never converted, so the
-- agent-facing capacity tile and the 50% posting gate still ran on the old
-- basis. Nothing regressed - this surface was simply left behind.
--
-- THE FIX
-- `eligible_rents.due_today_amount` / `due_yesterday_amount` now come from
-- `agent_expected_day_plans` for that plan and day. Everything downstream -
-- expected_daily, the tenant counts, the per-plan capping, all the percentages -
-- derives from those two columns, so the whole view moves onto the pinned bill
-- with one change.
--
-- The weekly-lapsed penalty is preserved as a FLOOR (GREATEST of the pin and the
-- lapsed amount), so no agent is treated more leniently than before on that
-- dimension.
--
-- THE PART THAT MATTERS MOST: A ZERO BILL IS NOT A PASS
-- When expected was 0 the view returned today_pct = 1, and the gate
-- (`enforce_agent_daily_eligibility`, GREATEST(effective, raw_today, raw_yesterday)
-- >= 0.50) therefore PASSED. Switching the denominator to the pinned bill without
-- addressing that would have handed unrestricted posting to every agent whose
-- book is entirely past its cycle - because nothing is pinned for a dead
-- schedule.
--
-- Measured before applying: 19 such agents, holding 65,459,916 of past-cycle
-- debt between them, 0 weekly plans and 0 not-yet-started plans among them. They
-- are not having a quiet day; their schedules are exhausted and unpaid.
--
-- So the zero-expected branch now passes ONLY if the agent has no outstanding
-- balance on a plan past its cycle end (`stale_debt`). An agent with genuinely
-- nothing due still passes; an agent with a dead, unpaid book stays blocked.
--
-- IMPACT, measured on 77 agents with tenants at the time of writing:
--     total daily target   14,071,814 -> 6,778,716
--     agents passing the gate      30 -> 37   (9 unblocked, 2 newly blocked)
--     zero-bill agents passing              0
--     naive swap without the guard would have unblocked 26, including all 19 above
--
-- Single-agent lookup measured at ~86 ms, which is the path the rent-request
-- insert trigger takes.

CREATE OR REPLACE VIEW public.v_agent_daily_eligibility AS
  WITH day_start AS (
    SELECT ((now() AT TIME ZONE 'Africa/Kampala')::date::timestamp AT TIME ZONE 'Africa/Kampala') AS ts,
           (now() AT TIME ZONE 'Africa/Kampala')::date AS d_today,
           (now() AT TIME ZONE 'Africa/Kampala')::date - 1 AS d_yesterday,
           (((now() AT TIME ZONE 'Africa/Kampala')::date - 6)::timestamp AT TIME ZONE 'Africa/Kampala') AS week_ts
  ), pin_days AS (
    -- The authoritative daily bill, written once at 00:05 EAT and never changed.
    SELECT ep.rent_request_id,
           COALESCE(SUM(ep.expected_ugx) FILTER (WHERE ep.day = ds.d_today), 0) AS pin_today,
           COALESCE(SUM(ep.expected_ugx) FILTER (WHERE ep.day = ds.d_yesterday), 0) AS pin_yesterday
    FROM agent_expected_day_plans ep CROSS JOIN day_start ds
    WHERE ep.day IN (ds.d_today, ds.d_yesterday)
    GROUP BY ep.rent_request_id
  ), stale_debt AS (
    -- Outstanding balance on plans whose schedule has already ended. Used only to
    -- decide whether "nothing billed today" means "nothing to do" (pass) or
    -- "a dead book that is still owing" (block).
    SELECT COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
           SUM(GREATEST(COALESCE(rr.total_repayment,0) - COALESCE(rr.amount_repaid,0), 0)) AS past_cycle_owed
    FROM rent_requests rr CROSS JOIN day_start ds
    WHERE rr.status = ANY (ARRAY['funded','repaying'])
      AND (COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date)
           + COALESCE(rr.duration_days,0) - 1) < ds.d_today
      AND (COALESCE(rr.total_repayment,0) - COALESCE(rr.amount_repaid,0)) > 0
    GROUP BY 1
  ), all_rents AS (
    SELECT rr.agent_id, rr.id AS rent_request_id, rr.tenant_id, rr.daily_repayment,
           rr.amount_repaid, rr.total_repayment, rr.funded_at,
           COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date) AS starts_on,
           CASE WHEN rr.repayment_frequency_locked
                THEN lower(COALESCE(rr.repayment_frequency,'daily')) = 'weekly'
                ELSE lower(COALESCE(rr.repayment_frequency,'daily')) = 'weekly'
                     OR rent_request_is_weekly_shape(rr.duration_days, rr.registration_type) END AS is_weekly
    FROM rent_requests rr
    WHERE ((rr.status = ANY (ARRAY['funded','repaying']))
           OR rr.status = 'completed' AND (EXISTS (SELECT 1 FROM agent_collections ac0
                WHERE ac0.amount > 0 AND ac0.created_at >= ((now() AT TIME ZONE 'Africa/Kampala')::date::timestamp AT TIME ZONE 'Africa/Kampala')
                  AND (ac0.rent_request_id = rr.id OR ac0.rent_request_id IS NULL AND ac0.tenant_id IS NOT NULL AND ac0.tenant_id = rr.tenant_id))))
      AND COALESCE(rr.agent_payment_status,'paying') <> 'not_paying'
  ), week_paid AS (
    SELECT ar.rent_request_id FROM all_rents ar CROSS JOIN day_start ds
    WHERE ar.is_weekly AND (EXISTS (SELECT 1 FROM agent_collections ac
      WHERE ac.created_at >= ds.week_ts AND ac.amount > 0
        AND (ac.rent_request_id = ar.rent_request_id OR ac.rent_request_id IS NULL AND ac.tenant_id IS NOT NULL AND ac.tenant_id = ar.tenant_id)))
  ), active_rents AS (
    SELECT ar.agent_id, ar.rent_request_id, ar.tenant_id, ar.daily_repayment, ar.amount_repaid,
           ar.total_repayment, ar.funded_at, ar.starts_on, ar.is_weekly,
           ar.is_weekly AND ar.starts_on IS NOT NULL AND (ar.starts_on + 7) <= ds.d_today AND wp.rent_request_id IS NULL AS weekly_lapsed
    FROM all_rents ar CROSS JOIN day_start ds LEFT JOIN week_paid wp ON wp.rent_request_id = ar.rent_request_id
  ), prior_paid AS (
    SELECT ac.rent_request_id, sum(ac.amount) AS paid_before_today
    FROM agent_collections ac CROSS JOIN day_start ds
    WHERE ac.rent_request_id IS NOT NULL AND ac.created_at < ds.ts GROUP BY ac.rent_request_id
  ), paused AS (
    SELECT DISTINCT p.rent_request_id FROM rent_repayment_pauses p
    WHERE p.status = 'active' AND p.resumed_at IS NULL
      AND (p.resume_on IS NULL OR p.resume_on >= (now() AT TIME ZONE 'Africa/Kampala')::date)
  ), reversed AS (
    SELECT DISTINCT r.rent_request_id FROM agent_tenant_float_reversals r
    UNION SELECT DISTINCT arr.rent_request_id FROM agent_allocation_return_requests arr
    WHERE arr.status = 'approved' AND arr.rent_request_id IS NOT NULL
  ), landlord_settled AS (
    SELECT DISTINCT a_1.rent_request_id FROM agent_landlord_float_allocations a_1
    WHERE a_1.rent_request_id IS NOT NULL AND a_1.paid_out_amount > 0
  ), alloc_activity AS (
    SELECT a_1.rent_request_id, max(GREATEST(a_1.created_at, COALESCE(a_1.updated_at, a_1.created_at))) AS last_change
    FROM agent_landlord_float_allocations a_1 WHERE a_1.rent_request_id IS NOT NULL GROUP BY a_1.rent_request_id
  ), live_rents AS (
    SELECT ar.agent_id, ar.rent_request_id, ar.tenant_id, ar.daily_repayment, ar.amount_repaid,
           ar.total_repayment, ar.funded_at, ar.starts_on, ar.is_weekly, ar.weekly_lapsed
    FROM active_rents ar CROSS JOIN day_start ds
      LEFT JOIN prior_paid pp ON pp.rent_request_id = ar.rent_request_id
      LEFT JOIN alloc_activity aa ON aa.rent_request_id = ar.rent_request_id
      LEFT JOIN reversed rv ON rv.rent_request_id = ar.rent_request_id
      LEFT JOIN paused pz ON pz.rent_request_id = ar.rent_request_id
      LEFT JOIN landlord_settled ls ON ls.rent_request_id = ar.rent_request_id
      LEFT JOIN LATERAL (SELECT count(*) AS open_allocs FROM agent_landlord_float_allocations oa_1
        WHERE oa_1.rent_request_id = ar.rent_request_id AND (oa_1.status = ANY (ARRAY['open','partially_paid','return_pending']))) oa ON true
    WHERE (rv.rent_request_id IS NULL OR COALESCE(pp.paid_before_today,0) > 0)
      AND pz.rent_request_id IS NULL
      AND ((COALESCE(ar.total_repayment,0) - COALESCE(ar.amount_repaid,0)) > 0
           OR (EXISTS (SELECT 1 FROM agent_collections ac2 WHERE ac2.amount > 0 AND ac2.created_at >= ds.ts
                AND (ac2.rent_request_id = ar.rent_request_id OR ac2.rent_request_id IS NULL AND ac2.tenant_id IS NOT NULL AND ac2.tenant_id = ar.tenant_id))))
      AND (COALESCE(pp.paid_before_today,0) > 0
           OR (ar.funded_at IS NULL OR ar.funded_at < ds.ts) AND (aa.last_change IS NULL OR aa.last_change < ds.ts)
               AND (ls.rent_request_id IS NOT NULL OR COALESCE(oa.open_allocs,0) = 0))
  ), weekly_stats AS (
    SELECT lr.agent_id, count(*)::integer AS weekly_plan_count,
           count(*) FILTER (WHERE lr.weekly_lapsed)::integer AS weekly_lapsed_count,
           COALESCE(sum(COALESCE(lr.daily_repayment,0) * 7), 0) AS weekly_expected_week
    FROM live_rents lr WHERE lr.is_weekly GROUP BY lr.agent_id
  ), eligible_rents AS (
    -- The one substantive change: the day's obligation is the PINNED amount for
    -- this plan on this day, with the weekly-lapsed penalty kept as a floor.
    SELECT lr.agent_id, lr.rent_request_id, lr.tenant_id, COALESCE(lr.daily_repayment,0) AS daily_repayment,
      GREATEST(COALESCE(pd.pin_today,0),
        CASE WHEN lr.is_weekly AND lr.weekly_lapsed
             THEN GREATEST(COALESCE(lr.daily_repayment,0)*7 - COALESCE(wk.week_paid,0), 0) ELSE 0 END) AS due_today_amount,
      GREATEST(COALESCE(pd.pin_yesterday,0),
        CASE WHEN lr.is_weekly AND lr.weekly_lapsed
             THEN GREATEST(COALESCE(lr.daily_repayment,0)*7 - COALESCE(wk.week_paid,0), 0) ELSE 0 END) AS due_yesterday_amount,
      GREATEST(COALESCE(pd.pin_today,0),
        CASE WHEN lr.is_weekly AND lr.weekly_lapsed
             THEN GREATEST(COALESCE(lr.daily_repayment,0)*7 - COALESCE(wk.week_paid,0), 0) ELSE 0 END) > 0 AS due_today,
      GREATEST(COALESCE(pd.pin_yesterday,0),
        CASE WHEN lr.is_weekly AND lr.weekly_lapsed
             THEN GREATEST(COALESCE(lr.daily_repayment,0)*7 - COALESCE(wk.week_paid,0), 0) ELSE 0 END) > 0 AS due_yesterday
    FROM live_rents lr CROSS JOIN day_start ds
      LEFT JOIN pin_days pd ON pd.rent_request_id = lr.rent_request_id
      LEFT JOIN LATERAL (SELECT COALESCE(sum(ac3.amount),0) AS week_paid FROM agent_collections ac3
        WHERE ac3.created_at >= ds.week_ts AND ac3.amount > 0
          AND (ac3.rent_request_id = lr.rent_request_id OR ac3.rent_request_id IS NULL AND ac3.tenant_id IS NOT NULL AND ac3.tenant_id = lr.tenant_id)) wk ON true
  ), expected AS (
    SELECT er.agent_id, count(*)::integer AS active_count,
           COALESCE(sum(er.due_today_amount),0) AS expected_daily,
           COALESCE(sum(er.due_yesterday_amount),0) AS expected_yesterday,
           count(*) FILTER (WHERE er.due_today)::integer AS due_today_count,
           count(*) FILTER (WHERE er.due_yesterday)::integer AS due_yesterday_count
    FROM eligible_rents er GROUP BY er.agent_id
  ), agents AS (
    SELECT expected.agent_id FROM expected UNION SELECT weekly_stats.agent_id FROM weekly_stats
  ), collection_events AS (
    SELECT ac.agent_id, ac.rent_request_id, ac.tenant_id, ac.amount,
           (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS day
    FROM agent_collections ac
    WHERE ac.created_at >= (((now() AT TIME ZONE 'Africa/Kampala')::date - 1)::timestamp AT TIME ZONE 'Africa/Kampala')
  ), matched AS (
    SELECT er.agent_id, er.rent_request_id, er.due_today_amount, er.due_yesterday_amount, ce.day, sum(ce.amount) AS tenant_paid
    FROM eligible_rents er JOIN collection_events ce ON ce.agent_id = er.agent_id
      AND (ce.rent_request_id = er.rent_request_id OR ce.rent_request_id IS NULL AND ce.tenant_id IS NOT NULL AND ce.tenant_id = er.tenant_id)
    GROUP BY er.agent_id, er.rent_request_id, er.due_today_amount, er.due_yesterday_amount, ce.day
  ), per_day AS (
    SELECT m.agent_id, m.day,
           sum(LEAST(m.tenant_paid, GREATEST(CASE WHEN m.day = ((SELECT day_start.d_today FROM day_start)) THEN m.due_today_amount ELSE m.due_yesterday_amount END, 0))) AS capped_paid,
           count(*) FILTER (WHERE m.tenant_paid > 0 AND CASE WHEN m.day = ((SELECT day_start.d_today FROM day_start)) THEN m.due_today_amount ELSE m.due_yesterday_amount END > 0)::integer AS tenants_paid
    FROM matched m GROUP BY m.agent_id, m.day
  ), raw_collected AS (
    SELECT m.agent_id,
           sum(CASE WHEN m.day = ((SELECT day_start.d_today FROM day_start)) THEN m.tenant_paid ELSE 0 END) AS paid_today,
           sum(CASE WHEN m.day = ((SELECT day_start.d_yesterday FROM day_start)) THEN m.tenant_paid ELSE 0 END) AS paid_yesterday
    FROM matched m GROUP BY m.agent_id
  ), coverage AS (
    SELECT per_day.agent_id,
      COALESCE(sum(per_day.capped_paid) FILTER (WHERE per_day.day = ((SELECT day_start.d_today FROM day_start))),0) AS capped_paid_today,
      COALESCE(sum(per_day.capped_paid) FILTER (WHERE per_day.day = ((SELECT day_start.d_yesterday FROM day_start))),0) AS capped_paid_yesterday,
      COALESCE(max(per_day.tenants_paid) FILTER (WHERE per_day.day = ((SELECT day_start.d_today FROM day_start))),0) AS tenants_paid_today,
      COALESCE(max(per_day.tenants_paid) FILTER (WHERE per_day.day = ((SELECT day_start.d_yesterday FROM day_start))),0) AS tenants_paid_yesterday
    FROM per_day GROUP BY per_day.agent_id
  )
  SELECT a.agent_id,
    COALESCE(e.active_count,0) AS active_count,
    COALESCE(e.expected_daily,0) AS expected_daily,
    COALESCE(rc.paid_today,0) AS paid_today,
    COALESCE(rc.paid_yesterday,0) AS paid_yesterday,
    CASE WHEN COALESCE(e.expected_daily,0) > 0
         THEN round(LEAST(COALESCE(cv.capped_paid_today,0), e.expected_daily) / e.expected_daily, 4)
         ELSE CASE WHEN COALESCE(sd.past_cycle_owed,0) > 0 THEN 0::numeric ELSE 1::numeric END END AS today_pct,
    CASE WHEN COALESCE(e.expected_yesterday,0) > 0
         THEN round(LEAST(COALESCE(cv.capped_paid_yesterday,0), e.expected_yesterday) / e.expected_yesterday, 4)
         ELSE CASE WHEN COALESCE(sd.past_cycle_owed,0) > 0 THEN 0::numeric ELSE 1::numeric END END AS yesterday_pct,
    GREATEST(
      CASE WHEN COALESCE(e.expected_daily,0) > 0
           THEN round(LEAST(COALESCE(cv.capped_paid_today,0), e.expected_daily) / e.expected_daily, 4)
           ELSE CASE WHEN COALESCE(sd.past_cycle_owed,0) > 0 THEN 0::numeric ELSE 1::numeric END END,
      CASE WHEN COALESCE(e.expected_yesterday,0) > 0
           THEN round(LEAST(COALESCE(cv.capped_paid_yesterday,0), e.expected_yesterday) / e.expected_yesterday, 4)
           ELSE CASE WHEN COALESCE(sd.past_cycle_owed,0) > 0 THEN 0::numeric ELSE 1::numeric END END) AS effective_pct,
    CASE WHEN COALESCE(e.expected_daily,0) > 0 THEN round(COALESCE(rc.paid_today,0) / e.expected_daily, 4) ELSE 0::numeric END AS raw_today_pct,
    CASE WHEN COALESCE(e.expected_yesterday,0) > 0 THEN round(COALESCE(rc.paid_yesterday,0) / e.expected_yesterday, 4) ELSE 0::numeric END AS raw_yesterday_pct,
    COALESCE(e.due_today_count,0) AS tenants_due,
    LEAST(COALESCE(cv.tenants_paid_today,0), COALESCE(e.due_today_count,0)) AS tenants_paid_today,
    LEAST(COALESCE(cv.tenants_paid_yesterday,0), COALESCE(e.due_yesterday_count,0)) AS tenants_paid_yesterday,
    CASE WHEN COALESCE(e.due_today_count,0) > 0
         THEN round(LEAST(COALESCE(cv.tenants_paid_today,0), e.due_today_count)::numeric / e.due_today_count::numeric, 4)
         ELSE CASE WHEN COALESCE(sd.past_cycle_owed,0) > 0 THEN 0::numeric ELSE 1::numeric END END AS coverage_today,
    CASE WHEN COALESCE(e.due_yesterday_count,0) > 0
         THEN round(LEAST(COALESCE(cv.tenants_paid_yesterday,0), e.due_yesterday_count)::numeric / e.due_yesterday_count::numeric, 4)
         ELSE CASE WHEN COALESCE(sd.past_cycle_owed,0) > 0 THEN 0::numeric ELSE 1::numeric END END AS coverage_yesterday,
    GREATEST(
      CASE WHEN COALESCE(e.due_today_count,0) > 0
           THEN round(LEAST(COALESCE(cv.tenants_paid_today,0), e.due_today_count)::numeric / e.due_today_count::numeric, 4)
           ELSE CASE WHEN COALESCE(sd.past_cycle_owed,0) > 0 THEN 0::numeric ELSE 1::numeric END END,
      CASE WHEN COALESCE(e.due_yesterday_count,0) > 0
           THEN round(LEAST(COALESCE(cv.tenants_paid_yesterday,0), e.due_yesterday_count)::numeric / e.due_yesterday_count::numeric, 4)
           ELSE CASE WHEN COALESCE(sd.past_cycle_owed,0) > 0 THEN 0::numeric ELSE 1::numeric END END) AS effective_coverage,
    COALESCE(ws.weekly_plan_count,0) AS weekly_plan_count,
    COALESCE(ws.weekly_lapsed_count,0) AS weekly_lapsed_count,
    COALESCE(ws.weekly_expected_week,0) AS weekly_expected_week
  FROM agents a
    LEFT JOIN expected e USING (agent_id)
    LEFT JOIN weekly_stats ws USING (agent_id)
    LEFT JOIN raw_collected rc USING (agent_id)
    LEFT JOIN coverage cv USING (agent_id)
    LEFT JOIN stale_debt sd USING (agent_id);

COMMENT ON VIEW public.v_agent_daily_eligibility IS
  'Agent daily collection performance and the 50% posting gate, scored against the pinned daily bill (agent_expected_day_plans) rather than every plan''s daily rate. A day with nothing billed passes only when the agent has no outstanding balance on a plan past its cycle end.';
