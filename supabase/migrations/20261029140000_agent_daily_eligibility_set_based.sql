-- get_agent_daily_eligibility was averaging 1.07s (max 7.9s) over 1,190 calls and
-- hitting the authenticated 8s statement_timeout. Two separate causes:
--
-- 1. _agent_expected_effective__impl walked every expired daily Rent Plan and,
--    per plan, scanned landlord_payouts (no index on rent_request_id: 550
--    sequential scans, ~193ms) and agent_collections through the created_at
--    index (973 loops, ~1,719 rows thrown away each time, ~613ms). The daily
--    view calls that helper for every agent, and the RPC reads the view, so
--    one agent paid for the whole fleet.
-- 2. The RPC then threw away every row whose agent_id was not in p_agent_ids.
--
-- The helper below does the same arithmetic in two grouped passes (payouts,
-- collections since the rule-week Thursday). Compared read-only to the
-- previous body on 2026-10-27: 6,072 rows over the last 7 Kampala days, every
-- agent, 0 rows different (EXCEPT ALL both ways).
--
-- _agent_daily_eligibility_for is that same daily view, limited to the asked
-- agents before the scans. NULL still means every agent (the view keeps its
-- own copy and its caller gate). The RPC never passes NULL: a null argument
-- stays an empty result, as `agent_id = ANY(NULL)` did.
--
-- Indexes are ordinary CREATE INDEX, not CONCURRENTLY. landlord_payouts is
-- about 1,600 rows and agent_collections about 19,000, so the build holds a
-- brief ShareLock. CONCURRENTLY cannot run inside the transaction a migration
-- file is applied in, and a failed CONCURRENTLY index is left invalid.
--
-- Return shape, SECURITY DEFINER, STABLE, search_path and the EXECUTE grants
-- of the two existing functions are unchanged. The new function is closed
-- (owner and service_role only). Not applied to production by this change.
-- Version 20261029140000 sorts after every migration already on lovable
-- (latest file 20261029130000). Production schema_migrations max on
-- 2026-10-27 was 20261028152000, so this is not inserted before history.

CREATE INDEX IF NOT EXISTS idx_landlord_payouts_rent_request_id
  ON public.landlord_payouts (rent_request_id);

CREATE INDEX IF NOT EXISTS idx_agent_collections_rent_request_live_created
  ON public.agent_collections (rent_request_id, created_at)
  WHERE reversed_at IS NULL AND amount > 0;

CREATE OR REPLACE FUNCTION public._agent_expected_effective__impl(p_agent_ids uuid[], p_from date, p_to date)
RETURNS TABLE(day date, agent_id uuid, rent_request_id uuid, tenant_id uuid, expected_ugx numeric, is_normal_day boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH weeks AS (
    SELECT DISTINCT public._agent_rule_week_start(g::date) AS lo
    FROM generate_series(p_from, p_to, interval '1 day') g
  ), payout_floor AS (
    -- Same date rent_plan_billable_from returns, once for every plan.
    SELECT lp.rent_request_id,
           (min(COALESCE(lp.finops_disbursed_at, lp.disbursed_at)) AT TIME ZONE 'Africa/Kampala')::date + 1 AS bill_from
    FROM public.landlord_payouts lp
    WHERE lp.status IN ('awaiting_agent_receipt', 'disbursed', 'completed')
    GROUP BY lp.rent_request_id
  ), paid AS (
    -- One pass per rule week. A collection on or after that Thursday counts,
    -- including one that also falls in a later week in the same window.
    SELECT w.lo, ac.rent_request_id, sum(ac.amount) AS paid
    FROM weeks w
    JOIN public.agent_collections ac
      ON ac.rent_request_id IS NOT NULL
     AND ac.reversed_at IS NULL
     AND ac.amount > 0
     AND ac.created_at >= (w.lo::timestamp AT TIME ZONE 'Africa/Kampala')
    GROUP BY w.lo, ac.rent_request_id
  ), cand AS (
    SELECT wk.lo,
           COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
           rr.id AS rent_request_id,
           rr.tenant_id,
           rr.daily_repayment AS daily,
           GREATEST(
             wk.lo,
             GREATEST(COALESCE(rr.repayment_starts_on, '-infinity'::date), COALESCE(pf.bill_from, '-infinity'::date)),
             public.agent_arrears_billing_go_live()
           ) AS s0,
           GREATEST(COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0) + COALESCE(pd.paid, 0), 0) AS owed_at_start
    FROM weeks wk
    CROSS JOIN public.rent_requests rr
    LEFT JOIN payout_floor pf ON pf.rent_request_id = rr.id
    LEFT JOIN paid pd ON pd.rent_request_id = rr.id AND pd.lo = wk.lo
    WHERE rr.status = 'repaying'
      AND COALESCE(rr.agent_payment_status, 'paying') <> 'not_paying'
      AND lower(COALESCE(rr.repayment_frequency, 'daily')) <> 'weekly'
      AND COALESCE(rr.daily_repayment, 0) > 0
      AND COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0) > 0
      AND COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date)
            + COALESCE(rr.duration_days, 0) - 1 < wk.lo
      AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL
      AND (p_agent_ids IS NULL OR COALESCE(rr.assigned_agent_id, rr.agent_id) = ANY (p_agent_ids))
      AND EXISTS (SELECT 1 FROM public.agent_expected_day_plans e0 WHERE e0.rent_request_id = rr.id)
      AND NOT EXISTS (
        SELECT 1 FROM public.rent_repayment_pauses z
        WHERE z.rent_request_id = rr.id AND z.status = 'active' AND z.resumed_at IS NULL
          AND (z.resume_on IS NULL OR z.resume_on >= LEAST(wk.lo + 6, p_to)))
  ), normal_days AS (
    SELECT c.agent_id, c.rent_request_id, c.tenant_id, g::date AS day,
           LEAST(c.daily, GREATEST(c.owed_at_start - c.daily * (row_number() OVER (PARTITION BY c.lo, c.rent_request_id ORDER BY g) - 1), 0)) AS amount
    FROM cand c
    CROSS JOIN LATERAL generate_series(c.s0, LEAST(c.lo + 6, p_to), interval '1 day') g
  ), pins AS (
    SELECT e.day, e.agent_id, e.rent_request_id, e.tenant_id, e.expected_ugx
    FROM public.agent_expected_day_plans e
    WHERE e.day BETWEEN p_from AND p_to
      AND e.agent_id IS NOT NULL
      AND e.expected_ugx > 0
      AND (p_agent_ids IS NULL OR e.agent_id = ANY (p_agent_ids))
  )
  SELECT COALESCE(p.day, n.day),
         COALESCE(p.agent_id, n.agent_id),
         COALESCE(p.rent_request_id, n.rent_request_id),
         COALESCE(p.tenant_id, n.tenant_id),
         GREATEST(COALESCE(p.expected_ugx, 0), COALESCE(n.amount, 0)),
         COALESCE(n.amount, 0) > COALESCE(p.expected_ugx, 0)
  FROM pins p
  FULL JOIN (SELECT * FROM normal_days WHERE day >= p_from AND amount > 0) n
    ON n.day = p.day AND n.rent_request_id = p.rent_request_id AND n.agent_id = p.agent_id;
$function$;

-- Daily eligibility for exactly the agents asked for. NULL means every agent,
-- which is how a staff read of the whole book stays possible for service_role.
-- The figures are the ones v_agent_daily_eligibility already publishes.
CREATE OR REPLACE FUNCTION public._agent_daily_eligibility_for(p_agent_ids uuid[])
RETURNS TABLE(
  agent_id uuid,
  active_count integer,
  expected_daily numeric,
  paid_today numeric,
  paid_yesterday numeric,
  today_pct numeric,
  yesterday_pct numeric,
  effective_pct numeric,
  raw_today_pct numeric,
  raw_yesterday_pct numeric,
  tenants_due integer,
  tenants_paid_today integer,
  tenants_paid_yesterday integer,
  coverage_today numeric,
  coverage_yesterday numeric,
  effective_coverage numeric,
  weekly_plan_count integer,
  weekly_lapsed_count integer,
  weekly_expected_week numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH day_start AS (
    SELECT (((now() AT TIME ZONE 'Africa/Kampala')::date)::timestamp AT TIME ZONE 'Africa/Kampala') AS ts,
           (now() AT TIME ZONE 'Africa/Kampala')::date AS d_today,
           ((now() AT TIME ZONE 'Africa/Kampala')::date - 1) AS d_yesterday,
           (((now() AT TIME ZONE 'Africa/Kampala')::date - 6)::timestamp AT TIME ZONE 'Africa/Kampala') AS week_ts
  ), pin_scope AS (
    -- Pins and normal days are stored on the plan's owner, which is
    -- assigned_agent_id when set and otherwise agent_id. Include both, plus
    -- whoever a yesterday/today pin row names, so a reassigned plan keeps the
    -- same summed bill the unfiltered helper produced.
    SELECT CASE
      WHEN p_agent_ids IS NULL THEN NULL::uuid[]
      ELSE (
        SELECT COALESCE(array_agg(DISTINCT x.id), '{}'::uuid[])
        FROM (
          SELECT u.id
          FROM unnest(p_agent_ids) AS u(id)
          WHERE u.id IS NOT NULL
          UNION
          SELECT rr.assigned_agent_id
          FROM public.rent_requests rr
          WHERE rr.assigned_agent_id IS NOT NULL
            AND rr.agent_id = ANY (p_agent_ids)
          UNION
          SELECT e.agent_id
          FROM public.agent_expected_day_plans e
          JOIN public.rent_requests rr ON rr.id = e.rent_request_id
          WHERE e.agent_id IS NOT NULL
            AND e.day >= ((now() AT TIME ZONE 'Africa/Kampala')::date - 1)
            AND rr.agent_id = ANY (p_agent_ids)
        ) x
      )
    END AS ids
  ), pin_days AS (
    SELECT ep.rent_request_id,
           COALESCE(sum(ep.expected_ugx) FILTER (WHERE ep.day = ds.d_today), 0) AS pin_today,
           COALESCE(sum(ep.expected_ugx) FILTER (WHERE ep.day = ds.d_yesterday), 0) AS pin_yesterday
    FROM day_start ds
    CROSS JOIN pin_scope sc
    CROSS JOIN LATERAL public._agent_expected_effective__impl(sc.ids, ds.d_yesterday, ds.d_today) ep
    GROUP BY ep.rent_request_id
  ), stale_debt AS (
    SELECT COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
           sum(GREATEST(COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0), 0)) AS past_cycle_owed
    FROM public.rent_requests rr
    CROSS JOIN day_start ds
    WHERE rr.status = ANY (ARRAY['funded', 'repaying'])
      AND (COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date) + COALESCE(rr.duration_days, 0) - 1) < ds.d_today
      AND (COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0)) > 0
      AND (p_agent_ids IS NULL OR COALESCE(rr.assigned_agent_id, rr.agent_id) = ANY (p_agent_ids))
    GROUP BY COALESCE(rr.assigned_agent_id, rr.agent_id)
  ), recent_billed_agents AS (
    SELECT DISTINCT xb.agent_id
    FROM public.agent_expected_day_plans xb
    WHERE xb.agent_id IS NOT NULL
      AND xb.day >= ((now() AT TIME ZONE 'Africa/Kampala')::date - 1)
      AND (p_agent_ids IS NULL OR xb.agent_id = ANY (p_agent_ids))
  ), all_rents AS (
    SELECT rr.agent_id,
           rr.status,
           rr.id AS rent_request_id,
           rr.tenant_id,
           rr.daily_repayment,
           rr.amount_repaid,
           rr.total_repayment,
           rr.funded_at,
           COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date) AS starts_on,
           CASE
             WHEN rr.repayment_frequency_locked THEN lower(COALESCE(rr.repayment_frequency, 'daily')) = 'weekly'
             ELSE lower(COALESCE(rr.repayment_frequency, 'daily')) = 'weekly'
                  OR public.rent_request_is_weekly_shape(rr.duration_days, rr.registration_type)
           END AS is_weekly
    FROM public.rent_requests rr
    CROSS JOIN day_start ds
    WHERE (
        rr.status = ANY (ARRAY['funded', 'repaying'])
        OR (
          rr.status = 'completed'
          AND EXISTS (
            SELECT 1
            FROM public.agent_collections ac0
            WHERE ac0.reversed_at IS NULL
              AND ac0.amount > 0
              AND ac0.created_at >= ds.ts
              AND (
                ac0.rent_request_id = rr.id
                OR (ac0.rent_request_id IS NULL AND ac0.tenant_id IS NOT NULL AND ac0.tenant_id = rr.tenant_id)
              )
          )
        )
      )
      AND COALESCE(rr.agent_payment_status, 'paying') <> 'not_paying'
      AND (p_agent_ids IS NULL OR rr.agent_id = ANY (p_agent_ids))
  ), week_paid AS (
    SELECT ar.rent_request_id
    FROM all_rents ar
    CROSS JOIN day_start ds
    WHERE ar.is_weekly
      AND EXISTS (
        SELECT 1
        FROM public.agent_collections ac
        WHERE ac.created_at >= ds.week_ts
          AND ac.amount > 0
          AND (
            ac.rent_request_id = ar.rent_request_id
            OR (ac.rent_request_id IS NULL AND ac.tenant_id IS NOT NULL AND ac.tenant_id = ar.tenant_id)
          )
      )
  ), active_rents AS (
    SELECT ar.agent_id, ar.status, ar.rent_request_id, ar.tenant_id, ar.daily_repayment,
           ar.amount_repaid, ar.total_repayment, ar.funded_at, ar.starts_on, ar.is_weekly,
           (ar.is_weekly AND ar.starts_on IS NOT NULL AND (ar.starts_on + 7) <= ds.d_today AND wp.rent_request_id IS NULL) AS weekly_lapsed
    FROM all_rents ar
    CROSS JOIN day_start ds
    LEFT JOIN week_paid wp ON wp.rent_request_id = ar.rent_request_id
  ), prior_paid AS (
    SELECT ac.rent_request_id, sum(ac.amount) AS paid_before_today
    FROM public.agent_collections ac
    CROSS JOIN day_start ds
    WHERE ac.rent_request_id IS NOT NULL
      AND ac.created_at < ds.ts
      AND (
        p_agent_ids IS NULL
        OR ac.rent_request_id IN (SELECT rr.id FROM public.rent_requests rr WHERE rr.agent_id = ANY (p_agent_ids))
      )
    GROUP BY ac.rent_request_id
  ), paused AS (
    SELECT DISTINCT p.rent_request_id
    FROM public.rent_repayment_pauses p
    WHERE p.status = 'active'
      AND p.resumed_at IS NULL
      AND (p.resume_on IS NULL OR p.resume_on >= (now() AT TIME ZONE 'Africa/Kampala')::date)
  ), reversal_marks AS (
    SELECT r.rent_request_id, r.created_at AS reversed_at
    FROM public.agent_tenant_float_reversals r
    WHERE r.rent_request_id IS NOT NULL
    UNION ALL
    SELECT arr.rent_request_id, COALESCE(arr.cfo_decision_at, arr.updated_at, arr.created_at) AS reversed_at
    FROM public.agent_allocation_return_requests arr
    WHERE arr.status = 'approved' AND arr.rent_request_id IS NOT NULL
  ), reversal_latest AS (
    SELECT rm.rent_request_id, max(rm.reversed_at) AS reversed_at
    FROM reversal_marks rm
    GROUP BY rm.rent_request_id
  ), reversed AS (
    SELECT rl.rent_request_id
    FROM reversal_latest rl
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.agent_landlord_float_allocations al
      WHERE al.rent_request_id = rl.rent_request_id
        AND al.paid_out_amount > 0
        AND COALESCE(al.updated_at, al.created_at) > rl.reversed_at
    )
  ), landlord_settled AS (
    SELECT DISTINCT a_1.rent_request_id
    FROM public.agent_landlord_float_allocations a_1
    WHERE a_1.rent_request_id IS NOT NULL AND a_1.paid_out_amount > 0
  ), alloc_activity AS (
    SELECT a_1.rent_request_id,
           max(GREATEST(a_1.created_at, COALESCE(a_1.updated_at, a_1.created_at))) AS last_change
    FROM public.agent_landlord_float_allocations a_1
    WHERE a_1.rent_request_id IS NOT NULL
    GROUP BY a_1.rent_request_id
  ), open_allocs AS (
    SELECT oa.rent_request_id, count(*)::bigint AS open_allocs
    FROM public.agent_landlord_float_allocations oa
    WHERE oa.rent_request_id IS NOT NULL
      AND oa.status = ANY (ARRAY['open', 'partially_paid', 'return_pending'])
    GROUP BY oa.rent_request_id
  ), live_rents AS (
    SELECT ar.agent_id, ar.status, ar.rent_request_id, ar.tenant_id, ar.daily_repayment,
           ar.amount_repaid, ar.total_repayment, ar.funded_at, ar.starts_on, ar.is_weekly, ar.weekly_lapsed
    FROM active_rents ar
    CROSS JOIN day_start ds
    LEFT JOIN prior_paid pp ON pp.rent_request_id = ar.rent_request_id
    LEFT JOIN alloc_activity aa ON aa.rent_request_id = ar.rent_request_id
    LEFT JOIN reversed rv ON rv.rent_request_id = ar.rent_request_id
    LEFT JOIN paused pz ON pz.rent_request_id = ar.rent_request_id
    LEFT JOIN landlord_settled ls ON ls.rent_request_id = ar.rent_request_id
    LEFT JOIN open_allocs oa ON oa.rent_request_id = ar.rent_request_id
    WHERE (rv.rent_request_id IS NULL OR COALESCE(pp.paid_before_today, 0) > 0)
      AND pz.rent_request_id IS NULL
      AND (
        (COALESCE(ar.total_repayment, 0) - COALESCE(ar.amount_repaid, 0)) > 0
        OR EXISTS (
          SELECT 1
          FROM public.agent_collections ac2
          WHERE ac2.amount > 0
            AND ac2.created_at >= ds.ts
            AND (
              ac2.rent_request_id = ar.rent_request_id
              OR (ac2.rent_request_id IS NULL AND ac2.tenant_id IS NOT NULL AND ac2.tenant_id = ar.tenant_id)
            )
        )
      )
      AND (
        COALESCE(pp.paid_before_today, 0) > 0
        OR (
          (ar.funded_at IS NULL OR ar.funded_at < ds.ts)
          AND (aa.last_change IS NULL OR aa.last_change < ds.ts)
          AND (ls.rent_request_id IS NOT NULL OR COALESCE(oa.open_allocs, 0) = 0)
        )
      )
  ), weekly_stats AS (
    SELECT lr.agent_id,
           count(*)::integer AS weekly_plan_count,
           count(*) FILTER (WHERE lr.weekly_lapsed)::integer AS weekly_lapsed_count,
           COALESCE(sum(COALESCE(lr.daily_repayment, 0) * 7), 0) AS weekly_expected_week
    FROM live_rents lr
    WHERE lr.is_weekly
    GROUP BY lr.agent_id
  ), eligible_rents AS (
    SELECT lr.agent_id,
           lr.status,
           lr.rent_request_id,
           lr.tenant_id,
           (pd.rent_request_id IS NOT NULL) AS was_billed,
           COALESCE(lr.daily_repayment, 0) AS daily_repayment,
           CASE
             WHEN pd.rent_request_id IS NOT NULL THEN COALESCE(pd.pin_today, 0)
             ELSE COALESCE(fb.amount, 0)
           END AS due_today_amount,
           CASE
             WHEN pd.rent_request_id IS NOT NULL THEN COALESCE(pd.pin_yesterday, 0)
             ELSE COALESCE(fb.amount, 0)
           END AS due_yesterday_amount,
           (COALESCE(pd.pin_today, 0) > 0 OR COALESCE(fb.amount, 0) > 0) AS due_today,
           (COALESCE(pd.pin_yesterday, 0) > 0 OR COALESCE(fb.amount, 0) > 0) AS due_yesterday
    FROM live_rents lr
    LEFT JOIN pin_days pd ON pd.rent_request_id = lr.rent_request_id
    LEFT JOIN LATERAL (
      SELECT CASE
        WHEN pd.rent_request_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM recent_billed_agents rb WHERE rb.agent_id = lr.agent_id)
         AND (NOT lr.is_weekly OR lr.weekly_lapsed)
         AND COALESCE(lr.daily_repayment, 0) > 0
        THEN LEAST(lr.daily_repayment, GREATEST(COALESCE(lr.total_repayment, 0) - COALESCE(lr.amount_repaid, 0), 0))
        ELSE NULL::numeric
      END AS amount
    ) fb ON true
  ), expected AS (
    SELECT er.agent_id,
           count(*)::integer AS active_count,
           COALESCE(sum(er.due_today_amount), 0) AS expected_daily,
           COALESCE(sum(er.due_yesterday_amount), 0) AS expected_yesterday,
           count(*) FILTER (WHERE er.due_today)::integer AS due_today_count,
           count(*) FILTER (WHERE er.due_yesterday)::integer AS due_yesterday_count
    FROM eligible_rents er
    WHERE er.status = 'repaying' OR er.was_billed
    GROUP BY er.agent_id
  ), agents AS (
    SELECT expected.agent_id FROM expected
    UNION
    SELECT weekly_stats.agent_id FROM weekly_stats
  ), collection_events AS (
    SELECT ac.agent_id, ac.rent_request_id, ac.tenant_id, ac.amount,
           (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS day
    FROM public.agent_collections ac
    WHERE ac.created_at >= ((((now() AT TIME ZONE 'Africa/Kampala')::date - 1)::timestamp) AT TIME ZONE 'Africa/Kampala')
      AND (p_agent_ids IS NULL OR ac.agent_id = ANY (p_agent_ids))
  ), matched AS (
    SELECT er.agent_id, er.rent_request_id, er.due_today_amount, er.due_yesterday_amount, ce.day,
           sum(ce.amount) AS tenant_paid
    FROM eligible_rents er
    JOIN collection_events ce
      ON ce.agent_id = er.agent_id
     AND (ce.rent_request_id = er.rent_request_id
          OR (ce.rent_request_id IS NULL AND ce.tenant_id IS NOT NULL AND ce.tenant_id = er.tenant_id))
    GROUP BY er.agent_id, er.rent_request_id, er.due_today_amount, er.due_yesterday_amount, ce.day
  ), per_day AS (
    SELECT m.agent_id,
           m.day,
           sum(LEAST(m.tenant_paid, GREATEST(
             CASE WHEN m.day = (SELECT d_today FROM day_start) THEN m.due_today_amount ELSE m.due_yesterday_amount END,
             0))) AS capped_paid,
           count(*) FILTER (WHERE m.tenant_paid > 0 AND (
             CASE WHEN m.day = (SELECT d_today FROM day_start) THEN m.due_today_amount ELSE m.due_yesterday_amount END
           ) > 0)::integer AS tenants_paid
    FROM matched m
    GROUP BY m.agent_id, m.day
  ), raw_collected AS (
    SELECT m.agent_id,
           sum(CASE WHEN m.day = (SELECT d_today FROM day_start) THEN m.tenant_paid ELSE 0 END) AS paid_today,
           sum(CASE WHEN m.day = (SELECT d_yesterday FROM day_start) THEN m.tenant_paid ELSE 0 END) AS paid_yesterday
    FROM matched m
    GROUP BY m.agent_id
  ), coverage AS (
    SELECT per_day.agent_id,
           COALESCE(sum(per_day.capped_paid) FILTER (WHERE per_day.day = (SELECT d_today FROM day_start)), 0) AS capped_paid_today,
           COALESCE(sum(per_day.capped_paid) FILTER (WHERE per_day.day = (SELECT d_yesterday FROM day_start)), 0) AS capped_paid_yesterday,
           COALESCE(max(per_day.tenants_paid) FILTER (WHERE per_day.day = (SELECT d_today FROM day_start)), 0) AS tenants_paid_today,
           COALESCE(max(per_day.tenants_paid) FILTER (WHERE per_day.day = (SELECT d_yesterday FROM day_start)), 0) AS tenants_paid_yesterday
    FROM per_day
    GROUP BY per_day.agent_id
  ), scored AS (
    SELECT a.agent_id,
           COALESCE(e.active_count, 0) AS active_count,
           COALESCE(e.expected_daily, 0) AS expected_daily,
           COALESCE(rc.paid_today, 0) AS paid_today,
           COALESCE(rc.paid_yesterday, 0) AS paid_yesterday,
           CASE
             WHEN COALESCE(e.expected_daily, 0) > 0
               THEN round(LEAST(COALESCE(cv.capped_paid_today, 0), e.expected_daily) / e.expected_daily, 4)
             WHEN COALESCE(sd.past_cycle_owed, 0) > 0 THEN 0
             ELSE 1
           END AS today_pct,
           CASE
             WHEN COALESCE(e.expected_yesterday, 0) > 0
               THEN round(LEAST(COALESCE(cv.capped_paid_yesterday, 0), e.expected_yesterday) / e.expected_yesterday, 4)
             WHEN COALESCE(sd.past_cycle_owed, 0) > 0 THEN 0
             ELSE 1
           END AS yesterday_pct,
           CASE
             WHEN COALESCE(e.expected_daily, 0) > 0 THEN round(COALESCE(rc.paid_today, 0) / e.expected_daily, 4)
             ELSE 0
           END AS raw_today_pct,
           CASE
             WHEN COALESCE(e.expected_yesterday, 0) > 0 THEN round(COALESCE(rc.paid_yesterday, 0) / e.expected_yesterday, 4)
             ELSE 0
           END AS raw_yesterday_pct,
           COALESCE(e.due_today_count, 0) AS tenants_due,
           LEAST(COALESCE(cv.tenants_paid_today, 0), COALESCE(e.due_today_count, 0)) AS tenants_paid_today,
           LEAST(COALESCE(cv.tenants_paid_yesterday, 0), COALESCE(e.due_yesterday_count, 0)) AS tenants_paid_yesterday,
           CASE
             WHEN COALESCE(e.due_today_count, 0) > 0
               THEN round(LEAST(COALESCE(cv.tenants_paid_today, 0), e.due_today_count)::numeric / e.due_today_count::numeric, 4)
             WHEN COALESCE(sd.past_cycle_owed, 0) > 0 THEN 0
             ELSE 1
           END AS coverage_today,
           CASE
             WHEN COALESCE(e.due_yesterday_count, 0) > 0
               THEN round(LEAST(COALESCE(cv.tenants_paid_yesterday, 0), e.due_yesterday_count)::numeric / e.due_yesterday_count::numeric, 4)
             WHEN COALESCE(sd.past_cycle_owed, 0) > 0 THEN 0
             ELSE 1
           END AS coverage_yesterday,
           COALESCE(ws.weekly_plan_count, 0) AS weekly_plan_count,
           COALESCE(ws.weekly_lapsed_count, 0) AS weekly_lapsed_count,
           COALESCE(ws.weekly_expected_week, 0) AS weekly_expected_week
    FROM agents a
    LEFT JOIN expected e USING (agent_id)
    LEFT JOIN weekly_stats ws USING (agent_id)
    LEFT JOIN raw_collected rc USING (agent_id)
    LEFT JOIN coverage cv USING (agent_id)
    LEFT JOIN stale_debt sd USING (agent_id)
  )
  SELECT s.agent_id,
         s.active_count,
         s.expected_daily,
         s.paid_today,
         s.paid_yesterday,
         s.today_pct,
         s.yesterday_pct,
         GREATEST(s.today_pct, s.yesterday_pct) AS effective_pct,
         s.raw_today_pct,
         s.raw_yesterday_pct,
         s.tenants_due,
         s.tenants_paid_today,
         s.tenants_paid_yesterday,
         s.coverage_today,
         s.coverage_yesterday,
         GREATEST(s.coverage_today, s.coverage_yesterday) AS effective_coverage,
         s.weekly_plan_count,
         s.weekly_lapsed_count,
         s.weekly_expected_week
  FROM scored s;
$function$;

CREATE OR REPLACE FUNCTION public.get_agent_daily_eligibility__impl(p_agent_ids uuid[])
RETURNS TABLE(
  agent_id uuid,
  active_count integer,
  expected_daily numeric,
  paid_today numeric,
  paid_yesterday numeric,
  today_pct numeric,
  yesterday_pct numeric,
  effective_pct numeric,
  raw_today_pct numeric,
  raw_yesterday_pct numeric,
  tenants_due integer,
  tenants_paid_today integer,
  tenants_paid_yesterday integer,
  coverage_today numeric,
  coverage_yesterday numeric,
  effective_coverage numeric,
  weekly_plan_count integer,
  weekly_lapsed_count integer,
  weekly_expected_week numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  -- A null argument matches the old `agent_id = ANY(NULL)` result: no rows.
  -- An empty array is the same. The body treats NULL as "every agent", so the
  -- RPC boundary translates NULL before the call.
  SELECT f.agent_id, f.active_count, f.expected_daily,
         f.paid_today, f.paid_yesterday,
         f.today_pct, f.yesterday_pct, f.effective_pct,
         f.raw_today_pct, f.raw_yesterday_pct,
         f.tenants_due, f.tenants_paid_today, f.tenants_paid_yesterday,
         f.coverage_today, f.coverage_yesterday, f.effective_coverage,
         f.weekly_plan_count, f.weekly_lapsed_count, f.weekly_expected_week
  FROM public._agent_daily_eligibility_for(
    CASE WHEN p_agent_ids IS NULL THEN ARRAY[]::uuid[] ELSE p_agent_ids END
  ) f
  WHERE f.agent_id = ANY (p_agent_ids);
$function$;

REVOKE ALL ON FUNCTION public._agent_expected_effective__impl(uuid[], date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._agent_expected_effective__impl(uuid[], date, date) TO service_role;

REVOKE ALL ON FUNCTION public._agent_daily_eligibility_for(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._agent_daily_eligibility_for(uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.get_agent_daily_eligibility__impl(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_daily_eligibility__impl(uuid[]) TO service_role;

-- The wrapper's grant is already authenticated + service_role, and not anon.
-- Restated so a reader of this file can see it. CREATE OR REPLACE keeps it.
REVOKE ALL ON FUNCTION public.get_agent_daily_eligibility(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_agent_daily_eligibility(uuid[]) TO authenticated, service_role;
