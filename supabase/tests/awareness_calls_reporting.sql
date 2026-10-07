-- Awareness call reports: a controlled data set inside one DO block that ends in an exception, so NOTHING is kept.
-- Five calls are put on exact Kampala (UTC+3) day boundaries, then every report is read as the ops test user and compared with the
-- figures worked out by hand (the expected values are in the report text). The report is the exception message.
--   calls: c1 agent_ops tenant answered 20:59 UTC on 6 Oct (= 23:59 EAT, 6 Oct)   c2 same tenant, answered, 21:00 UTC (= 00:00 EAT, 7 Oct)
--          c3 service_centre landlord no_answer   c4 tenant_ops tenant answered   c5 service_centre same landlord, other phone format, phone_off
-- Expected: calls 5, answered 3 (60.0%), people called 3, reached 2, plans 3, callers 3; 30M / codes / explained 1-1-1;
--           trend 6 Oct = 1 call, 7 Oct = 4 calls; by team service_centre 2, agent_ops 2, tenant_ops 1; log newest first c5, c4, c3, c2;
--           coverage gaps equal an independent recount from rent_requests; non-staff, manager-only and signed-out callers refused;
--           bad team, bad subject type, from after to and a window over 366 days refused; anon has no execute grant.
DO $$
DECLARE
  ops uuid := 'b9078b67-dc4c-473a-bc88-9510d4bcd0dc';
  rra record; rrb record; rrc record; x uuid; y uuid; plain uuid; mgr_only uuid;
  out text := ''; s jsonb; t jsonb; c jsonb; g jsonb; l jsonb; l2 jsonb; reg text; n int; exp_gaps int; exp_passed int;
  w_from timestamptz := '2026-10-06'; w_to timestamptz := '2026-10-07';
BEGIN
  SELECT r.id, r.tenant_id, r.landlord_id, p.phone INTO rra FROM rent_requests r JOIN profiles p ON p.id = r.tenant_id
   WHERE r.agent_ops_reviewed_at >= '2026-10-01' AND r.agent_ops_reviewed_at < '2026-10-07' AND p.phone IS NOT NULL LIMIT 1;
  SELECT r.id, r.tenant_id, r.landlord_id INTO rrb FROM rent_requests r WHERE r.landlord_id IS NOT NULL AND r.id <> rra.id LIMIT 1;
  SELECT r.id, r.tenant_id, p.phone INTO rrc FROM rent_requests r JOIN profiles p ON p.id = r.tenant_id JOIN v_tlb_tenant_base tb ON tb.tenant_id = r.tenant_id
   WHERE tb.region IS NOT NULL AND r.id NOT IN (rra.id, rrb.id) AND p.phone IS NOT NULL LIMIT 1;
  SELECT tb.region INTO reg FROM v_tlb_tenant_base tb WHERE tb.tenant_id = rrc.tenant_id;
  SELECT id INTO x FROM profiles WHERE full_name IS NOT NULL AND id <> ops ORDER BY created_at LIMIT 1;
  SELECT id INTO y FROM profiles WHERE full_name IS NOT NULL AND id NOT IN (ops, x) ORDER BY created_at LIMIT 1;
  SELECT x2.id INTO plain FROM profiles x2 WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = x2.id AND ur.enabled AND ur.role NOT IN ('tenant','landlord','agent','supporter')) LIMIT 1;
  SELECT ur.user_id INTO mgr_only FROM user_roles ur WHERE ur.enabled AND ur.role = 'manager'
     AND NOT EXISTS (SELECT 1 FROM user_roles u2 WHERE u2.user_id = ur.user_id AND u2.enabled AND u2.role IN ('tenant_ops','coo','ceo','super_admin')) LIMIT 1;

  INSERT INTO rent_pipeline_awareness_calls (rent_request_id, subject_type, subject_user_id, subject_phone, caller_id, caller_team, pipeline_stage, dial_started_at, call_result, aware_30m, aware_merchant_codes, explained, note) VALUES
   (rra.id, 'tenant',   rra.tenant_id, rra.phone,          ops, 'agent_ops',      'pending',               '2026-10-06 20:59:00+00', 'answered',  'knew',         'heard',        'yes',    'c1'),
   (rra.id, 'tenant',   rra.tenant_id, rra.phone,          ops, 'agent_ops',      'pending',               '2026-10-06 21:00:00+00', 'answered',  'did_not_know', 'did_not_know', 'no',     'c2'),
   (rrb.id, 'landlord', NULL,          '0700333444',       x,   'service_centre', 'service_center_review', '2026-10-07 05:00:00+00', 'no_answer', NULL, NULL, NULL, 'c3'),
   (rrc.id, 'tenant',   rrc.tenant_id, rrc.phone,          y,   'tenant_ops',     'agent_ops_approved',    '2026-10-07 06:00:00+00', 'answered',  'heard',        'knew',         'partly', 'c4'),
   (rrb.id, 'landlord', NULL,          '+256 700 333 444', x,   'service_centre', 'service_center_review', '2026-10-07 07:00:00+00', 'phone_off', NULL, NULL, NULL, 'c5');

  PERFORM set_config('request.jwt.claim.sub', ops::text, true);

  s := public.awareness_calls_summary(w_from, w_to);
  out := out || format(E'\nSUMMARY %s days: calls=%s answered=%s (%s%%) people_called=%s reached=%s plans=%s callers=%s',
    s->'window'->>'days', s->'totals'->>'calls', s->'totals'->>'answered', s->'totals'->>'answered_pct', s->'totals'->>'people_called', s->'totals'->>'people_reached', s->'totals'->>'rent_plans_called', s->'totals'->>'callers');
  out := out || format(E'\n  30M %s/%s/%s | codes %s/%s/%s | explained %s/%s/%s',
    s->'aware_30m'->>'knew', s->'aware_30m'->>'heard', s->'aware_30m'->>'did_not_know', s->'aware_merchant_codes'->>'knew', s->'aware_merchant_codes'->>'heard', s->'aware_merchant_codes'->>'did_not_know',
    s->'explained'->>'yes', s->'explained'->>'partly', s->'explained'->>'no');
  out := out || format(E'\n  trend: %s', s->'trend');
  t := public.awareness_calls_by_team(w_from, w_to);
  out := out || format(E'\nBY TEAM: %s', (SELECT string_agg(r->>'team' || '=' || (r->>'calls') || '/' || (r->>'answered') || '/' || (r->>'people_reached'), ', ') FROM jsonb_array_elements(t->'rows') r));
  c := public.awareness_calls_by_caller(w_from, w_to);
  out := out || format(E'\nBY CALLER: total_callers=%s | %s', c->>'total_callers', (SELECT string_agg((r->>'caller_name') || ' (' || (r->>'team') || ') ' || (r->>'calls') || ' calls, reached ' || (r->>'people_reached'), ' ; ') FROM jsonb_array_elements(c->'rows') r));
  out := out || format(E'\nFILTERS: team=tenant_ops -> %s | subject=landlord -> %s | caller=y -> %s | region=%s -> %s | 7 Oct only -> %s | 6 Oct only -> %s | EAT timestamps for 6 Oct -> %s',
    public.awareness_calls_summary(w_from, w_to, 'tenant_ops')->'totals'->>'calls', public.awareness_calls_summary(w_from, w_to, NULL, NULL, 'landlord')->'totals'->>'calls',
    public.awareness_calls_summary(w_from, w_to, NULL, y)->'totals'->>'calls', reg, public.awareness_calls_summary(w_from, w_to, NULL, NULL, NULL, reg)->'totals'->>'calls',
    public.awareness_calls_summary('2026-10-07', '2026-10-07')->'totals'->>'calls', public.awareness_calls_summary('2026-10-06', '2026-10-06')->'totals'->>'calls',
    public.awareness_calls_summary('2026-10-05 21:00:00+00', '2026-10-06 20:59:59+00')->'totals'->>'calls');
  l := public.awareness_calls_log(w_from, w_to, NULL, NULL, NULL, NULL, 2, 0);
  l2 := public.awareness_calls_log(w_from, w_to, NULL, NULL, NULL, NULL, 2, 2);
  out := out || format(E'\nLOG total=%s | page1: %s | page2: %s', l->>'total', (SELECT string_agg(r->>'note', ',') FROM jsonb_array_elements(l->'rows') r), (SELECT string_agg(r->>'note', ',') FROM jsonb_array_elements(l2->'rows') r));

  g := public.awareness_coverage_gaps('2026-10-01', '2026-10-06');
  SELECT count(*) FILTER (WHERE NOT has_call), count(*) INTO exp_gaps, exp_passed FROM (
    SELECT st.stage, r.id, EXISTS (SELECT 1 FROM rent_pipeline_awareness_calls c2 WHERE c2.rent_request_id = r.id AND c2.pipeline_stage = st.stage) AS has_call
    FROM rent_requests r CROSS JOIN LATERAL (VALUES
      ('service_center_review', r.service_center_reviewed_at), ('pending', r.agent_ops_reviewed_at), ('agent_ops_approved', r.tenant_ops_reviewed_at),
      ('tenant_ops_approved', r.landlord_ops_reviewed_at), ('landlord_ops_approved', r.partner_ops_reviewed_at), ('partner_ops_approved', r.coo_reviewed_at),
      ('coo_approved', r.cfo_reviewed_at)) st(stage, at)
    WHERE st.at >= '2026-10-01 00:00 Africa/Kampala'::timestamptz AND st.at < '2026-10-07 00:00 Africa/Kampala'::timestamptz) q;
  out := out || format(E'\nGAPS 1-6 Oct: passed=%s with_call=%s without_call=%s total_gaps=%s | independent recount passed=%s gaps=%s | match=%s',
    g->'totals'->>'passed', g->'totals'->>'with_call', g->'totals'->>'without_call', g->>'total', exp_passed, exp_gaps,
    (g->'totals'->>'passed')::int = exp_passed AND (g->>'total')::int = exp_gaps);

  FOR n IN 1..7 LOOP
    BEGIN
      IF n = 1 THEN PERFORM set_config('request.jwt.claim.sub', plain::text, true); PERFORM public.awareness_calls_summary(w_from, w_to);
      ELSIF n = 2 THEN PERFORM set_config('request.jwt.claim.sub', mgr_only::text, true); PERFORM public.awareness_calls_log(w_from, w_to);
      ELSIF n = 3 THEN PERFORM set_config('request.jwt.claim.sub', '', true); PERFORM public.awareness_coverage_gaps(w_from, w_to);
      ELSIF n = 4 THEN PERFORM set_config('request.jwt.claim.sub', ops::text, true); PERFORM public.awareness_calls_summary(w_from, w_to, 'nonsense');
      ELSIF n = 5 THEN PERFORM public.awareness_calls_summary('2026-10-07', '2026-10-01');
      ELSIF n = 6 THEN PERFORM public.awareness_calls_summary('2025-01-01', '2026-10-01');
      ELSE PERFORM public.awareness_calls_by_team(w_from, w_to, NULL, NULL, 'supporter');
      END IF;
      out := out || format(E'\nREFUSAL %s: ALLOWED (BAD)', n);
    EXCEPTION WHEN OTHERS THEN out := out || format(E'\nREFUSAL %s: %s', n, SQLERRM);
    END;
  END LOOP;
  RAISE EXCEPTION '%', out;
END $$;
