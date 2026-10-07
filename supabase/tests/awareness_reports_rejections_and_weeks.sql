-- awareness_coverage_gaps (rejections, outcome, legacy 'agent_verified' calls) and awareness_calls_summary (p_bucket). One DO block that ends in
-- an exception, so NOTHING is kept; the report is the exception message. Compared with independent counts written a different way
-- (to_jsonb(rr)->>column per stage, no CROSS JOIN, no shared CTEs):
--   gaps: totals.passed = plans whose stage review time is in the window + rejected-at-stage plans with no review time on that stage
--         (dated by rejected_at); totals.rejected and the p_outcome filters equal the independent rejected / approved counts; every stage's
--         passed count matches; a rejection-only row has outcome rejected and no reviewer; the legacy names land on Tenant Ops / COO;
--         a controlled call stored as 'agent_verified' makes a Tenant Ops gap row become covered.
--   summary: week buckets (Monday to Sunday, first and last clipped) add up to the day total; day is the default; a bad bucket is refused.
DO $$
DECLARE
  ops uuid := 'b9078b67-dc4c-473a-bc88-9510d4bcd0dc';
  w_from timestamptz := '2026-09-01'; w_to timestamptz := '2026-10-07';
  g jsonb; g_rej jsonb; g_app jsonb; out text := ''; ind_passed int; ind_rej int; ind_rej_only int; got int;
  st record; ind int; leg record; rowx jsonb; target uuid; before_n int; after_n int; sd jsonb; sw jsonb; sdef jsonb; sum_days int; sum_weeks int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', ops::text, true);
  g := public.awareness_coverage_gaps(w_from, w_to, NULL, NULL, 200, 0);

  -- independent: every (plan, stage) whose review time is in the window, plus rejection-only moves (the report's window is Kampala days)
  SELECT count(*) FILTER (WHERE COALESCE(rv, CASE WHEN rstage = stage THEN rej_at END) >= '2026-09-01 00:00:00+03' AND COALESCE(rv, CASE WHEN rstage = stage THEN rej_at END) < '2026-10-08 00:00:00+03'),
         count(*) FILTER (WHERE COALESCE(rv, CASE WHEN rstage = stage THEN rej_at END) >= '2026-09-01 00:00:00+03' AND COALESCE(rv, CASE WHEN rstage = stage THEN rej_at END) < '2026-10-08 00:00:00+03'
                           AND rstage = stage AND (status = 'rejected' OR rv IS NULL)),
         count(*) FILTER (WHERE rv IS NULL AND rstage = stage AND rej_at >= '2026-09-01 00:00:00+03' AND rej_at < '2026-10-08 00:00:00+03')
    INTO ind_passed, ind_rej, ind_rej_only FROM (
      WITH stages(stage, col) AS (VALUES ('service_center_review','service_center_reviewed_at'), ('pending','agent_ops_reviewed_at'),
           ('agent_ops_approved','tenant_ops_reviewed_at'), ('tenant_ops_approved','landlord_ops_reviewed_at'), ('landlord_ops_approved','partner_ops_reviewed_at'),
           ('partner_ops_approved','coo_reviewed_at'), ('coo_approved','cfo_reviewed_at')),
      rs AS (SELECT r.id, to_jsonb(r) AS j,
               CASE WHEN r.rejected_at_stage IS NOT NULL THEN
                      (CASE r.rejected_at_stage WHEN 'agent_verified' THEN 'agent_ops_approved' WHEN 'coo' THEN 'partner_ops_approved' ELSE r.rejected_at_stage END)
                    WHEN (r.rejected_at IS NOT NULL OR r.status = 'rejected') AND r.service_center_reviewed_at IS NOT NULL THEN 'service_center_review' END AS rstage
             FROM rent_requests r)
      SELECT rs.id, s.stage, (rs.j->>s.col)::timestamptz AS rv, rs.rstage, (rs.j->>'status') AS status, (rs.j->>'rejected_at')::timestamptz AS rej_at
      FROM rs CROSS JOIN stages s) m;
  out := out || format(E'\nGAPS totals: report passed=%s rejected=%s | independent passed=%s rejected=%s (of which rejection-only moves: %s) | match=%s',
    g->'totals'->>'passed', g->'totals'->>'rejected', ind_passed, ind_rej, ind_rej_only, (g->'totals'->>'passed')::int = ind_passed AND (g->'totals'->>'rejected')::int = ind_rej);

  g_rej := public.awareness_coverage_gaps(w_from, w_to, NULL, NULL, 200, 0, NULL, NULL, 'rejected');
  g_app := public.awareness_coverage_gaps(w_from, w_to, NULL, NULL, 200, 0, NULL, NULL, 'approved');
  out := out || format(E'\nOUTCOME FILTER rejected: passed=%s (expect %s) | approved: passed=%s (expect %s) | sum=%s total=%s',
    g_rej->'totals'->>'passed', ind_rej, g_app->'totals'->>'passed', ind_passed - ind_rej, (g_rej->'totals'->>'passed')::int + (g_app->'totals'->>'passed')::int, g->'totals'->>'passed');

  FOR st IN SELECT x->>'stage' AS stage, (x->>'passed')::int AS passed, (x->>'rejected')::int AS rej FROM jsonb_array_elements(g->'by_stage') x LOOP
    out := out || format(E'\n  stage %-22s report passed=%s rejected=%s', st.stage, st.passed, st.rej);
  END LOOP;

  -- legacy names: rejected-at 'agent_verified' / 'coo' appear on Tenant Ops / COO (no unknown stage names exist today)
  SELECT count(*) INTO ind FROM rent_requests r WHERE r.rejected_at_stage = 'agent_verified' AND r.rejected_at >= '2026-09-01 00:00:00+03' AND r.rejected_at < '2026-10-08 00:00:00+03' AND r.tenant_ops_reviewed_at IS NULL;
  out := out || format(E'\nLEGACY agent_verified rejections with no Tenant Ops review in the window (independent)=%s', ind);
  SELECT count(*) INTO ind FROM rent_requests r WHERE r.rejected_at_stage = 'coo' AND r.rejected_at >= '2026-09-01 00:00:00+03' AND r.rejected_at < '2026-10-08 00:00:00+03' AND r.coo_reviewed_at IS NULL;
  out := out || format(E' | coo rejections with no COO review in the window (independent)=%s', ind);

  -- a rejection-only row: outcome rejected, no reviewer
  SELECT x INTO rowx FROM jsonb_array_elements(public.awareness_coverage_gaps(w_from, w_to, NULL, NULL, 200, 0, NULL, NULL, 'rejected')->'rows') x WHERE x->>'passed_by' IS NULL LIMIT 1;
  out := out || format(E'\nREJECTION-ONLY ROW: %s', COALESCE(left(rowx::text, 220), '<none in this window>'));

  -- the legacy 'agent_verified' call counts at Tenant Ops: pick a Tenant Ops move in the window with no call, record one such call, expect it to be covered
  SELECT (x->>'rent_request_id')::uuid INTO target FROM jsonb_array_elements(g->'rows') x WHERE x->>'stage' = 'agent_ops_approved' LIMIT 1;
  IF target IS NOT NULL THEN
    before_n := (public.awareness_coverage_gaps(w_from, w_to, 'tenant_ops', NULL, 1, 0)->'totals'->>'with_call')::int;
    INSERT INTO rent_pipeline_awareness_calls (rent_request_id, subject_type, subject_phone, caller_id, caller_team, pipeline_stage, dial_started_at, call_result, note)
      VALUES (target, 'tenant', '0700123456', ops, 'tenant_ops', 'agent_verified', now() - interval '1 hour', 'no_answer', 'legacy test');
    after_n := (public.awareness_coverage_gaps(w_from, w_to, 'tenant_ops', NULL, 1, 0)->'totals'->>'with_call')::int;
    out := out || format(E'\nLEGACY CALL stored as agent_verified: Tenant Ops with_call %s -> %s  [expect +1]', before_n, after_n);
  ELSE
    out := out || E'\nLEGACY CALL: skipped (no Tenant Ops gap in the window)';
  END IF;

  BEGIN PERFORM public.awareness_coverage_gaps(w_from, w_to, NULL, NULL, 5, 0, NULL, NULL, 'maybe'); out := out || E'\nBAD OUTCOME: NOT refused (unexpected)';
  EXCEPTION WHEN OTHERS THEN out := out || format(E'\nBAD OUTCOME refused: %s', SQLERRM); END;

  -- summary: day / week buckets over controlled calls (noon UTC = 15:00 Kampala, never near a day edge)
  INSERT INTO rent_pipeline_awareness_calls (rent_request_id, subject_type, subject_phone, caller_id, caller_team, pipeline_stage, dial_started_at, call_result, note)
    SELECT target, 'landlord', '0700999000', ops, 'tenant_ops', 'agent_verified', t, 'no_answer', 'bucket test' FROM unnest(ARRAY[
      '2026-09-29 12:00+00', '2026-10-05 12:00+00', '2026-10-06 12:00+00', '2026-10-06 13:00+00']::timestamptz[]) t WHERE target IS NOT NULL;
  sd := public.awareness_calls_summary('2026-09-23', '2026-10-07', 'tenant_ops', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'day');
  sw := public.awareness_calls_summary('2026-09-23', '2026-10-07', 'tenant_ops', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'week');
  sdef := public.awareness_calls_summary('2026-09-23', '2026-10-07', 'tenant_ops');
  SELECT sum((e->>'calls')::int) INTO sum_days FROM jsonb_array_elements(sd->'trend') e;
  SELECT sum((e->>'calls')::int) INTO sum_weeks FROM jsonb_array_elements(sw->'trend') e;
  out := out || format(E'\nSUMMARY day buckets=%s total=%s | week buckets=%s total=%s | totals.calls day=%s week=%s | default bucket=%s and equals day: %s',
    jsonb_array_length(sd->'trend'), sum_days, jsonb_array_length(sw->'trend'), sum_weeks, sd->'totals'->>'calls', sw->'totals'->>'calls', sdef->>'bucket', sdef->'trend' = sd->'trend');
  out := out || format(E'\nWEEKS (window 23 Sep to 7 Oct, expect 23 Sep-27 Sep, 28 Sep-4 Oct, 5 Oct-7 Oct): %s',
    (SELECT string_agg((e->>'day') || '..' || (e->>'period_end') || '=' || (e->>'calls'), ' | ' ORDER BY e->>'day') FROM jsonb_array_elements(sw->'trend') e));
  out := out || format(E'\nDAY OF 6 OCT calls=%s  [expect 2] | independent calls in window for the caller team: %s',
    (SELECT e->>'calls' FROM jsonb_array_elements(sd->'trend') e WHERE e->>'day' = '2026-10-06'),
    (SELECT count(*) FROM rent_pipeline_awareness_calls c WHERE c.caller_team = 'tenant_ops' AND c.dial_started_at >= '2026-09-23 00:00:00+03' AND c.dial_started_at < '2026-10-08 00:00:00+03'));
  BEGIN PERFORM public.awareness_calls_summary('2026-09-23', '2026-10-07', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'month'); out := out || E'\nBAD BUCKET: NOT refused (unexpected)';
  EXCEPTION WHEN OTHERS THEN out := out || format(E'\nBAD BUCKET refused: %s', SQLERRM); END;

  RAISE EXCEPTION E'awareness_reports_rejections_and_weeks report (rolled back, nothing kept):%', out;
END $$;

-- Second block: a window that contains rejection-only moves (rejected at a stage with no review time on it, 1 Apr to 31 Aug 2026 in the
-- live data: 24 at Agent Ops and 4 at Landlord Ops in April, 2 at Agent Ops in August = 31 with the stage-less rows). Expected: report totals equal
-- the independent counts, and passed minus the review-time-only count equals the rejection-only count.
DO $$
DECLARE
  ops uuid := 'b9078b67-dc4c-473a-bc88-9510d4bcd0dc';
  g jsonb; out text := ''; ind_passed int; ind_rej int; ind_rej_only int; old_style int; rowx jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', ops::text, true);
  g := public.awareness_coverage_gaps('2026-04-01', '2026-08-31', NULL, NULL, 200, 0);
  SELECT count(*) FILTER (WHERE COALESCE(rv, CASE WHEN rstage = stage THEN rej_at END) >= '2026-04-01 00:00:00+03' AND COALESCE(rv, CASE WHEN rstage = stage THEN rej_at END) < '2026-09-01 00:00:00+03'),
         count(*) FILTER (WHERE COALESCE(rv, CASE WHEN rstage = stage THEN rej_at END) >= '2026-04-01 00:00:00+03' AND COALESCE(rv, CASE WHEN rstage = stage THEN rej_at END) < '2026-09-01 00:00:00+03'
                           AND rstage = stage AND (status = 'rejected' OR rv IS NULL)),
         count(*) FILTER (WHERE rv IS NULL AND rstage = stage AND rej_at >= '2026-04-01 00:00:00+03' AND rej_at < '2026-09-01 00:00:00+03'),
         count(*) FILTER (WHERE rv >= '2026-04-01 00:00:00+03' AND rv < '2026-09-01 00:00:00+03')
    INTO ind_passed, ind_rej, ind_rej_only, old_style FROM (
      WITH stages(stage, col) AS (VALUES ('service_center_review','service_center_reviewed_at'), ('pending','agent_ops_reviewed_at'),
           ('agent_ops_approved','tenant_ops_reviewed_at'), ('tenant_ops_approved','landlord_ops_reviewed_at'), ('landlord_ops_approved','partner_ops_reviewed_at'),
           ('partner_ops_approved','coo_reviewed_at'), ('coo_approved','cfo_reviewed_at')),
      rs AS (SELECT r.id, to_jsonb(r) AS j,
               CASE WHEN r.rejected_at_stage IS NOT NULL THEN
                      (CASE r.rejected_at_stage WHEN 'agent_verified' THEN 'agent_ops_approved' WHEN 'coo' THEN 'partner_ops_approved' ELSE r.rejected_at_stage END)
                    WHEN (r.rejected_at IS NOT NULL OR r.status = 'rejected') AND r.service_center_reviewed_at IS NOT NULL THEN 'service_center_review' END AS rstage
             FROM rent_requests r)
      SELECT rs.id, s.stage, (rs.j->>s.col)::timestamptz AS rv, rs.rstage, (rs.j->>'status') AS status, (rs.j->>'rejected_at')::timestamptz AS rej_at
      FROM rs CROSS JOIN stages s) m;
  out := format(E'\nApr-Aug: report passed=%s rejected=%s | independent passed=%s rejected=%s rejection-only=%s | review-time-only=%s | passed - review-time-only = %s (should equal rejection-only)',
    g->'totals'->>'passed', g->'totals'->>'rejected', ind_passed, ind_rej, ind_rej_only, old_style, ind_passed - old_style);
  SELECT x INTO rowx FROM jsonb_array_elements(public.awareness_coverage_gaps('2026-04-01', '2026-08-31', NULL, NULL, 200, 0, NULL, NULL, 'rejected')->'rows') x WHERE x->>'passed_by' IS NULL LIMIT 1;
  out := out || format(E'\nREJECTION-ONLY ROW: stage=%s outcome=%s passed_day=%s reviewer=%s status_now=%s', rowx->>'stage', rowx->>'outcome', rowx->>'passed_day', COALESCE(rowx->>'passed_by_name','<none>'), rowx->>'current_status');
  RAISE EXCEPTION E'rolled back:%', out;
END $$;
