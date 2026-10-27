-- Rolled-back verification for 20261029140000_agent_daily_eligibility_set_based.sql
--
-- Run after that migration is applied. The block ends in RAISE EXCEPTION, so nothing is kept;
-- the error text IS the report. This statement's timeout is local to the transaction.
-- Do not change the database's statement_timeout.
--
-- Read-only, before the migration was applied (2026-10-27, project byrzshwlentqvktcksem):
--   helper rewrite vs live __impl, every agent, last 7 Kampala days: 6,072 rows, 0 diffs
--   helper rewrite vs live __impl, every agent, yesterday and today: 1,696 rows, 0 diffs, ~25ms
--   scoped eligibility SQL vs live get_agent_daily_eligibility__impl, five agents: 5 and 5, 0 diffs
--
--   A  the set-based helper equals the previous per-plan body (all agents, 7 Kampala days)
--   B  the same, for the 20 agents with the most repaying Rent Plans, yesterday and today
--   C  get_agent_daily_eligibility__impl equals the daily view for those 20
--   D  one call for every agent on the view equals the view
--   E  calls of 25 ids, concatenated, equal that one call
--   F  one id equals its row inside the full call; NULL and '{}' return no rows
--   G  grants, security settings, and the impl no longer reads the view

BEGIN;
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION pg_temp.agent_expected_effective_legacy(p_agent_ids uuid[], p_from date, p_to date)
RETURNS TABLE(day date, agent_id uuid, rent_request_id uuid, tenant_id uuid, expected_ugx numeric, is_normal_day boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH weeks AS (
    SELECT DISTINCT public._agent_rule_week_start(g::date) AS lo
    FROM generate_series(p_from, p_to, interval '1 day') g
  ), cand AS (
    SELECT wk.lo,
           COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
           rr.id AS rent_request_id,
           rr.tenant_id,
           rr.daily_repayment AS daily,
           GREATEST(wk.lo, public.rent_plan_billable_from(rr.id), public.agent_arrears_billing_go_live()) AS s0,
           GREATEST(COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0)
                    + COALESCE((SELECT sum(ac.amount) FROM public.agent_collections ac
                                WHERE ac.rent_request_id = rr.id AND ac.reversed_at IS NULL AND ac.amount > 0
                                  AND ac.created_at >= (wk.lo::timestamp AT TIME ZONE 'Africa/Kampala')), 0),
                    0) AS owed_at_start
    FROM weeks wk
    CROSS JOIN public.rent_requests rr
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

DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_ids uuid[];
  v_one uuid;
  v_off int;
  v_n int;
  v_a int;
  v_ok boolean;
BEGIN
  SELECT count(*) INTO v_n FROM (
    SELECT * FROM pg_temp.agent_expected_effective_legacy(NULL::uuid[], v_today - 6, v_today)
    EXCEPT ALL
    SELECT * FROM public._agent_expected_effective__impl(NULL::uuid[], v_today - 6, v_today)
  ) d;
  SELECT count(*) INTO v_a FROM (
    SELECT * FROM public._agent_expected_effective__impl(NULL::uuid[], v_today - 6, v_today)
    EXCEPT ALL
    SELECT * FROM pg_temp.agent_expected_effective_legacy(NULL::uuid[], v_today - 6, v_today)
  ) d;
  r := r || jsonb_build_object('step', 'A helper, all agents, 7 Kampala days', 'pass', v_n = 0 AND v_a = 0,
                               'detail', v_n || ' new-only, ' || v_a || ' old-only');

  SELECT COALESCE(array_agg(s.id), '{}'::uuid[]) INTO v_ids
  FROM (
    SELECT rr.agent_id AS id
    FROM public.rent_requests rr
    WHERE rr.status = 'repaying' AND rr.agent_id IS NOT NULL
    GROUP BY rr.agent_id
    ORDER BY count(*) DESC, rr.agent_id
    LIMIT 20
  ) s;
  SELECT count(*) INTO v_n FROM (
    SELECT * FROM pg_temp.agent_expected_effective_legacy(v_ids, v_today - 1, v_today)
    EXCEPT ALL
    SELECT * FROM public._agent_expected_effective__impl(v_ids, v_today - 1, v_today)
  ) d;
  SELECT count(*) INTO v_a FROM (
    SELECT * FROM public._agent_expected_effective__impl(v_ids, v_today - 1, v_today)
    EXCEPT ALL
    SELECT * FROM pg_temp.agent_expected_effective_legacy(v_ids, v_today - 1, v_today)
  ) d;
  r := r || jsonb_build_object('step', 'B helper, 20 agents, yesterday and today', 'pass', v_n = 0 AND v_a = 0,
                               'detail', v_n || ' / ' || v_a);

  SELECT count(*) INTO v_n FROM (
    SELECT * FROM public.get_agent_daily_eligibility__impl(v_ids)
    EXCEPT ALL
    SELECT v.agent_id, v.active_count, v.expected_daily,
           v.paid_today, v.paid_yesterday,
           v.today_pct, v.yesterday_pct, v.effective_pct,
           v.raw_today_pct, v.raw_yesterday_pct,
           v.tenants_due, v.tenants_paid_today, v.tenants_paid_yesterday,
           v.coverage_today, v.coverage_yesterday, v.effective_coverage,
           v.weekly_plan_count, v.weekly_lapsed_count, v.weekly_expected_week
    FROM public.v_agent_daily_eligibility v
    WHERE v.agent_id = ANY (v_ids)
  ) d;
  SELECT count(*) INTO v_a FROM (
    SELECT v.agent_id, v.active_count, v.expected_daily,
           v.paid_today, v.paid_yesterday,
           v.today_pct, v.yesterday_pct, v.effective_pct,
           v.raw_today_pct, v.raw_yesterday_pct,
           v.tenants_due, v.tenants_paid_today, v.tenants_paid_yesterday,
           v.coverage_today, v.coverage_yesterday, v.effective_coverage,
           v.weekly_plan_count, v.weekly_lapsed_count, v.weekly_expected_week
    FROM public.v_agent_daily_eligibility v
    WHERE v.agent_id = ANY (v_ids)
    EXCEPT ALL
    SELECT * FROM public.get_agent_daily_eligibility__impl(v_ids)
  ) d;
  r := r || jsonb_build_object('step', 'C impl equals the view for those 20', 'pass', v_n = 0 AND v_a = 0,
                               'detail', v_n || ' / ' || v_a);

  SELECT COALESCE(array_agg(v.agent_id), '{}'::uuid[]) INTO v_ids FROM public.v_agent_daily_eligibility v;
  CREATE TEMP TABLE _elig_full ON COMMIT DROP AS
    SELECT * FROM public.get_agent_daily_eligibility__impl(v_ids);
  SELECT count(*) INTO v_n FROM (
    SELECT * FROM _elig_full
    EXCEPT ALL
    SELECT v.agent_id, v.active_count, v.expected_daily,
           v.paid_today, v.paid_yesterday,
           v.today_pct, v.yesterday_pct, v.effective_pct,
           v.raw_today_pct, v.raw_yesterday_pct,
           v.tenants_due, v.tenants_paid_today, v.tenants_paid_yesterday,
           v.coverage_today, v.coverage_yesterday, v.effective_coverage,
           v.weekly_plan_count, v.weekly_lapsed_count, v.weekly_expected_week
    FROM public.v_agent_daily_eligibility v
  ) d;
  SELECT count(*) INTO v_a FROM (
    SELECT v.agent_id, v.active_count, v.expected_daily,
           v.paid_today, v.paid_yesterday,
           v.today_pct, v.yesterday_pct, v.effective_pct,
           v.raw_today_pct, v.raw_yesterday_pct,
           v.tenants_due, v.tenants_paid_today, v.tenants_paid_yesterday,
           v.coverage_today, v.coverage_yesterday, v.effective_coverage,
           v.weekly_plan_count, v.weekly_lapsed_count, v.weekly_expected_week
    FROM public.v_agent_daily_eligibility v
    EXCEPT ALL
    SELECT * FROM _elig_full
  ) d;
  r := r || jsonb_build_object('step', 'D one call for every view agent equals the view', 'pass', v_n = 0 AND v_a = 0,
                               'detail', (SELECT count(*) FROM _elig_full) || ' rows, ' || v_n || ' / ' || v_a);

  CREATE TEMP TABLE _elig_parts ON COMMIT DROP AS SELECT * FROM _elig_full WHERE false;
  v_off := 1;
  WHILE v_off <= COALESCE(cardinality(v_ids), 0) LOOP
    INSERT INTO _elig_parts
    SELECT * FROM public.get_agent_daily_eligibility__impl(v_ids[v_off:v_off + 24]);
    v_off := v_off + 25;
  END LOOP;
  SELECT count(*) INTO v_n FROM (
    SELECT * FROM _elig_parts EXCEPT ALL SELECT * FROM _elig_full
  ) d;
  SELECT count(*) INTO v_a FROM (
    SELECT * FROM _elig_full EXCEPT ALL SELECT * FROM _elig_parts
  ) d;
  r := r || jsonb_build_object('step', 'E batches of 25 equal the one call', 'pass', v_n = 0 AND v_a = 0,
                               'detail', v_n || ' / ' || v_a);

  v_one := v_ids[1];
  SELECT count(*) INTO v_n FROM (
    SELECT * FROM public.get_agent_daily_eligibility__impl(ARRAY[v_one])
    EXCEPT ALL
    SELECT * FROM _elig_full WHERE agent_id = v_one
  ) d;
  SELECT count(*) INTO v_a FROM public.get_agent_daily_eligibility__impl(NULL::uuid[]);
  SELECT count(*) INTO v_off FROM public.get_agent_daily_eligibility__impl('{}'::uuid[]);
  r := r || jsonb_build_object('step', 'F one id matches; NULL and empty return no rows',
                               'pass', v_n = 0 AND v_a = 0 AND v_off = 0,
                               'detail', jsonb_build_object('single_diff', v_n, 'null_rows', v_a, 'empty_rows', v_off));

  SELECT (
    has_function_privilege('authenticated', 'public.get_agent_daily_eligibility(uuid[])', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.get_agent_daily_eligibility(uuid[])', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.get_agent_daily_eligibility(uuid[])', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.get_agent_daily_eligibility__impl(uuid[])', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.get_agent_daily_eligibility__impl(uuid[])', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.get_agent_daily_eligibility__impl(uuid[])', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public._agent_expected_effective__impl(uuid[],date,date)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public._agent_expected_effective__impl(uuid[],date,date)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public._agent_expected_effective__impl(uuid[],date,date)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public._agent_daily_eligibility_for(uuid[])', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public._agent_daily_eligibility_for(uuid[])', 'EXECUTE')
    AND has_function_privilege('service_role', 'public._agent_daily_eligibility_for(uuid[])', 'EXECUTE')
  ) INTO v_ok;
  r := r || jsonb_build_object('step', 'G grants: wrapper open to authenticated; impls closed', 'pass', v_ok);

  SELECT bool_and(p.prosecdef AND p.provolatile = 's' AND 'search_path=public' = ANY (p.proconfig)) INTO v_ok
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('get_agent_daily_eligibility', 'get_agent_daily_eligibility__impl',
                      '_agent_expected_effective__impl', '_agent_daily_eligibility_for');
  r := r || jsonb_build_object('step', 'G security definer, stable, search_path public', 'pass', COALESCE(v_ok, false));

  SELECT position('v_agent_daily_eligibility' in p.prosrc) = 0 INTO v_ok
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_agent_daily_eligibility__impl';
  r := r || jsonb_build_object('step', 'G impl does not read the view', 'pass', COALESCE(v_ok, false));

  SELECT count(*) = 2 INTO v_ok
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname IN ('idx_landlord_payouts_rent_request_id', 'idx_agent_collections_rent_request_live_created');
  r := r || jsonb_build_object('step', 'G both indexes exist', 'pass', COALESCE(v_ok, false));

  RAISE EXCEPTION 'REPORT %', r;
END
$test$;
