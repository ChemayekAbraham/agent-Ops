-- Put every "expected" on the pinned daily bill.
--
-- THE DEFECT
-- `agent_expected_day_plans` is the bill: one row per plan per day, written
-- once at 00:05 EAT and never changed. Several surfaces ignored it and
-- re-derived expected live from `rent_requests.daily_repayment` instead, which
-- sums every plan active on the day regardless of what was actually billed.
--
-- The two are not close. On 2026-09-16:
--   pinned bill                      UGX  6,080,933
--   live daily_repayment sum         UGX 14,466,570   (238% of the bill)
--
-- So any screen on the live basis showed expected more than twice as high, and
-- coverage correspondingly crushed. Worse, `get_agent_ops_overview` used the
-- PIN for its KPI tiles (after 20260916250000) and the LIVE basis for its trend
-- chart, so the chart contradicted the tiles directly above it.
--
-- WHAT CHANGED
--   get_agent_ops_overview              trend `expected` series -> the pin
--   ops_tenant_ops_weekly_bundle        daily `expected_daily`  -> the pin
--   get_agent_products_services_report  `daily_receivable` and
--     (both overloads)                  `expected_cumulative`   -> the pin
--
-- `expected_cumulative` previously multiplied a plan's daily amount by the days
-- elapsed since it was funded. That is a model of what should have been billed,
-- not what was: it cannot know about a plan funded mid-window, a pin that was
-- never written, or a back-dated term start. Summing the pins over the window
-- answers the same question from the record rather than from arithmetic.
--
-- DELIBERATELY NOT CHANGED
-- `ops_tenant_ops_weekly_bundle`'s per-agent `cap.expected_daily` (the CTE
-- named `cap`) still sums live `daily_repayment` across an agent's whole book.
-- That is a CAPACITY measure - "how much does this agent's book bill per day" -
-- and is not window-scoped, so the pin is not the right source for it. It is
-- mislabelled rather than wrong, and renaming it is a UI change.
--
-- Each patch replaces only the expression, leaving the surrounding joins in
-- place: the new scalar subquery depends only on the grouping column, so the
-- GROUP BY still holds and the result is one value per bucket.
--
-- VERIFIED after applying, for 2026-09-16:
--   expected (pinned)   6,080,933      (was 14,466,570 on the live basis)
--   collected            1,801,579      capped per tenant, arrears excluded
--   pending              4,279,354
--   coverage                 29.6%
-- Both tenant-ops bundles re-executed successfully afterwards.

DO $pin$
DECLARE v_def text; v_before text; v_n int := 0;
BEGIN
  -- A. Agent Ops trend chart
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_agent_ops_overview';
  IF position('sum(rr.daily_repayment) * (CASE WHEN v_bucket_fmt' in v_def) > 0 THEN
    v_def := replace(v_def,
      'COALESCE(sum(rr.daily_repayment) * (CASE WHEN v_bucket_fmt = ''hour'' THEN 1.0/24.0 ELSE 1.0 END), 0) AS n',
      'COALESCE((SELECT sum(pp.expected_ugx) FROM public.agent_expected_day_plans pp'
      || ' WHERE pp.day = (b.ts AT TIME ZONE ''Africa/Kampala'')::date), 0)'
      || ' * (CASE WHEN v_bucket_fmt = ''hour'' THEN 1.0/24.0 ELSE 1.0 END) AS n');
    EXECUTE v_def; v_n := v_n + 1;
  END IF;

  -- B. Tenant Ops weekly, daily series
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'ops_tenant_ops_weekly_bundle';
  IF position('COALESCE(sum(rr.daily_repayment),0) AS expected_daily,' in v_def) > 0 THEN
    v_def := replace(v_def,
      'COALESCE(sum(rr.daily_repayment),0) AS expected_daily,',
      'COALESCE((SELECT sum(pp.expected_ugx) FROM public.agent_expected_day_plans pp'
      || ' WHERE pp.day = d.d),0) AS expected_daily,');
    EXECUTE v_def; v_n := v_n + 1;
  END IF;

  -- C. Products & services, both overloads
  FOR v_def IN
    SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_agent_products_services_report'
  LOOP
    v_before := v_def;
    v_def := replace(v_def,
      'COALESCE(sum(lr.daily_repayment),0) AS daily_receivable,',
      'COALESCE((SELECT sum(pp.expected_ugx) FROM public.agent_expected_day_plans pp'
      || ' WHERE pp.agent_id = a.id AND pp.day = v_day),0) AS daily_receivable,');
    v_def := replace(v_def,
      'COALESCE(sum(lr.daily_repayment * GREATEST(0, (v_day - GREATEST(v_from, COALESCE((lr.funded_at AT TIME ZONE ''Africa/Kampala'')::date, v_from))) + 1)),0) AS expected_cumulative,',
      'COALESCE((SELECT sum(pp.expected_ugx) FROM public.agent_expected_day_plans pp'
      || ' WHERE pp.agent_id = a.id AND pp.day BETWEEN v_from AND v_day),0) AS expected_cumulative,');
    v_def := replace(v_def,
      '''daily_receivable'', (SELECT COALESCE(sum(daily_repayment),0) FROM live_rents),',
      '''daily_receivable'', (SELECT COALESCE(sum(expected_ugx),0) FROM public.agent_expected_day_plans WHERE day = v_day),');
    v_def := replace(v_def,
      '''expected_cumulative'', (SELECT COALESCE(sum(daily_repayment * GREATEST(0, (v_day - GREATEST(v_from, COALESCE((funded_at AT TIME ZONE ''Africa/Kampala'')::date, v_from))) + 1)),0) FROM live_rents),',
      '''expected_cumulative'', (SELECT COALESCE(sum(expected_ugx),0) FROM public.agent_expected_day_plans WHERE day BETWEEN v_from AND v_day),');
    CONTINUE WHEN v_def = v_before;
    EXECUTE v_def; v_n := v_n + 1;
  END LOOP;

  RAISE NOTICE 'expected-basis patches applied: %', v_n;
END $pin$;

DO $verify$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname || coalesce('(' || pg_get_function_identity_arguments(p.oid) || ')',''), ', ')
    INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('get_agent_ops_overview','ops_tenant_ops_weekly_bundle',
                       'get_agent_products_services_report')
     AND position('agent_expected_day_plans' in p.prosrc) = 0;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'still not reading the pinned bill: %', v_bad;
  END IF;
  RAISE NOTICE 'every expected now comes from agent_expected_day_plans';
END $verify$;
