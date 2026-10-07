-- Awareness call reports: the filters added for the monitoring page (call result, answer choice, district, request status) and
-- awareness_calls_options(). One DO block that ends in an exception, so NOTHING is kept; the report is the exception message.
-- Uses the same five controlled calls as awareness_calls_reporting.sql:
--   c1 agent_ops tenant answered knew/heard/yes (6 Oct 23:59 EAT)   c2 same tenant answered did_not_know/did_not_know/no (7 Oct 00:00 EAT)
--   c3 service_centre landlord no_answer   c4 tenant_ops tenant answered heard/knew/partly   c5 service_centre same landlord phone_off
-- Expected: result=answered 3, no_answer 1, phone_off 1; aware_30m=heard 1, aware_merchant_codes=did_not_know 1, explained=yes 1, partly 1;
-- status and district filters equal an independent count; calls using only the original six arguments are unchanged (5 calls, 3 answered);
-- a field without an answer, a wrong answer for the field and an unknown result are refused; the options list the three callers.
DO $$
DECLARE
  ops uuid := 'b9078b67-dc4c-473a-bc88-9510d4bcd0dc';
  rra record; rrb record; rrc record; x uuid; y uuid; plain uuid;
  out text := ''; w_from timestamptz := '2026-10-06'; w_to timestamptz := '2026-10-07'; reg text; dist text; st_a text;
  exp_n int; got_n int; o jsonb; g jsonb; exp_g int; n int;
BEGIN
  SELECT r.id, r.tenant_id, r.status, p.phone INTO rra FROM rent_requests r JOIN profiles p ON p.id = r.tenant_id
   WHERE r.agent_ops_reviewed_at >= '2026-10-01' AND r.agent_ops_reviewed_at < '2026-10-07' AND p.phone IS NOT NULL LIMIT 1;
  SELECT r.id, r.tenant_id, r.landlord_id INTO rrb FROM rent_requests r WHERE r.landlord_id IS NOT NULL AND r.id <> rra.id LIMIT 1;
  SELECT r.id, r.tenant_id, p.phone INTO rrc FROM rent_requests r JOIN profiles p ON p.id = r.tenant_id JOIN v_tlb_tenant_base tb ON tb.tenant_id = r.tenant_id
   WHERE tb.region IS NOT NULL AND tb.district_name IS NOT NULL AND r.id NOT IN (rra.id, rrb.id) AND p.phone IS NOT NULL LIMIT 1;
  SELECT tb.region, tb.district_name INTO reg, dist FROM v_tlb_tenant_base tb WHERE tb.tenant_id = rrc.tenant_id;
  SELECT id INTO x FROM profiles WHERE full_name IS NOT NULL AND id <> ops ORDER BY created_at LIMIT 1;
  SELECT id INTO y FROM profiles WHERE full_name IS NOT NULL AND id NOT IN (ops, x) ORDER BY created_at LIMIT 1;
  SELECT x2.id INTO plain FROM profiles x2 WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = x2.id AND ur.enabled AND ur.role NOT IN ('tenant','landlord','agent','supporter')) LIMIT 1;
  st_a := rra.status;

  INSERT INTO rent_pipeline_awareness_calls (rent_request_id, subject_type, subject_user_id, subject_phone, caller_id, caller_team, pipeline_stage, dial_started_at, call_result, aware_30m, aware_merchant_codes, explained, note) VALUES
   (rra.id, 'tenant',   rra.tenant_id, rra.phone,          ops, 'agent_ops',      'pending',               '2026-10-06 20:59:00+00', 'answered',  'knew',         'heard',        'yes',    'c1'),
   (rra.id, 'tenant',   rra.tenant_id, rra.phone,          ops, 'agent_ops',      'pending',               '2026-10-06 21:00:00+00', 'answered',  'did_not_know', 'did_not_know', 'no',     'c2'),
   (rrb.id, 'landlord', NULL,          '0700333444',       x,   'service_centre', 'service_center_review', '2026-10-07 05:00:00+00', 'no_answer', NULL, NULL, NULL, 'c3'),
   (rrc.id, 'tenant',   rrc.tenant_id, rrc.phone,          y,   'tenant_ops',     'agent_ops_approved',    '2026-10-07 06:00:00+00', 'answered',  'heard',        'knew',         'partly', 'c4'),
   (rrb.id, 'landlord', NULL,          '+256 700 333 444', x,   'service_centre', 'service_center_review', '2026-10-07 07:00:00+00', 'phone_off', NULL, NULL, NULL, 'c5');

  PERFORM set_config('request.jwt.claim.sub', ops::text, true);

  out := out || format(E'\nUNCHANGED with only the original six arguments: calls=%s answered=%s people_called=%s  [expect 5 / 3 / 3]',
    public.awareness_calls_summary(w_from, w_to, NULL, NULL, NULL, NULL)->'totals'->>'calls', public.awareness_calls_summary(w_from, w_to)->'totals'->>'answered', public.awareness_calls_summary(w_from, w_to)->'totals'->>'people_called');
  out := out || format(E'\nRESULT answered=%s no_answer=%s phone_off=%s wrong_number=%s  [expect 3 / 1 / 1 / 0]',
    public.awareness_calls_summary(w_from, w_to, NULL, NULL, NULL, NULL, NULL, 'answered')->'totals'->>'calls', public.awareness_calls_summary(w_from, w_to, NULL, NULL, NULL, NULL, NULL, 'no_answer')->'totals'->>'calls',
    public.awareness_calls_summary(w_from, w_to, NULL, NULL, NULL, NULL, NULL, 'phone_off')->'totals'->>'calls', public.awareness_calls_summary(w_from, w_to, NULL, NULL, NULL, NULL, NULL, 'wrong_number')->'totals'->>'calls');
  out := out || format(E'\nANSWER 30M heard=%s | codes did_not_know=%s | explained yes=%s partly=%s no=%s | 30M knew=%s  [expect 1 / 1 / 1 / 1 / 1 / 1]',
    public.awareness_calls_summary(w_from, w_to, NULL, NULL, NULL, NULL, NULL, NULL, 'aware_30m', 'heard')->'totals'->>'calls',
    public.awareness_calls_summary(w_from, w_to, NULL, NULL, NULL, NULL, NULL, NULL, 'aware_merchant_codes', 'did_not_know')->'totals'->>'calls',
    public.awareness_calls_summary(w_from, w_to, NULL, NULL, NULL, NULL, NULL, NULL, 'explained', 'yes')->'totals'->>'calls',
    public.awareness_calls_summary(w_from, w_to, NULL, NULL, NULL, NULL, NULL, NULL, 'explained', 'partly')->'totals'->>'calls',
    public.awareness_calls_summary(w_from, w_to, NULL, NULL, NULL, NULL, NULL, NULL, 'explained', 'no')->'totals'->>'calls',
    public.awareness_calls_summary(w_from, w_to, NULL, NULL, NULL, NULL, NULL, NULL, 'aware_30m', 'knew')->'totals'->>'calls');

  SELECT count(*) INTO exp_n FROM rent_pipeline_awareness_calls c JOIN rent_requests r ON r.id = c.rent_request_id WHERE r.status = st_a;
  got_n := (public.awareness_calls_summary(w_from, w_to, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, st_a)->'totals'->>'calls')::int;
  out := out || format(E'\nSTATUS %s: filter=%s independent=%s match=%s', st_a, got_n, exp_n, got_n = exp_n);
  SELECT count(*) INTO exp_n FROM rent_pipeline_awareness_calls c JOIN rent_requests r ON r.id = c.rent_request_id JOIN v_tlb_tenant_base tb ON tb.tenant_id = r.tenant_id WHERE tb.district_name = dist;
  got_n := (public.awareness_calls_summary(w_from, w_to, NULL, NULL, NULL, NULL, dist)->'totals'->>'calls')::int;
  out := out || format(E'\nDISTRICT %s: filter=%s independent=%s match=%s | region+district=%s | wrong district=%s', dist, got_n, exp_n, got_n = exp_n,
    public.awareness_calls_summary(w_from, w_to, NULL, NULL, NULL, reg, dist)->'totals'->>'calls', public.awareness_calls_summary(w_from, w_to, NULL, NULL, NULL, NULL, 'No Such District')->'totals'->>'calls');
  out := out || format(E'\nCOMBINED answered + tenant_ops team + tenant: %s (expect 1) | log with result filter: total=%s rows=%s | by_team answered only: %s | by_caller phone_off: %s',
    public.awareness_calls_summary(w_from, w_to, 'tenant_ops', NULL, 'tenant', NULL, NULL, 'answered')->'totals'->>'calls',
    public.awareness_calls_log(w_from, w_to, NULL, NULL, NULL, NULL, 50, 0, NULL, 'answered')->>'total', jsonb_array_length(public.awareness_calls_log(w_from, w_to, NULL, NULL, NULL, NULL, 50, 0, NULL, 'answered')->'rows'),
    (SELECT string_agg(r->>'team' || '=' || (r->>'calls'), ',') FROM jsonb_array_elements(public.awareness_calls_by_team(w_from, w_to, NULL, NULL, NULL, NULL, NULL, 'answered')->'rows') r),
    (SELECT string_agg((r->>'caller_name') || '=' || (r->>'calls'), ',') FROM jsonb_array_elements(public.awareness_calls_by_caller(w_from, w_to, NULL, NULL, NULL, NULL, 200, NULL, 'phone_off')->'rows') r));

  -- coverage gaps with the status filter equals an independent recount
  g := public.awareness_coverage_gaps('2026-10-01', '2026-10-06', NULL, NULL, 5, 0, NULL, 'completed');
  SELECT count(*) FILTER (WHERE NOT has_call) INTO exp_g FROM (
    SELECT st.stage, r.id, EXISTS (SELECT 1 FROM rent_pipeline_awareness_calls c2 WHERE c2.rent_request_id = r.id AND c2.pipeline_stage = st.stage) AS has_call
    FROM rent_requests r CROSS JOIN LATERAL (VALUES
      ('service_center_review', r.service_center_reviewed_at), ('pending', r.agent_ops_reviewed_at), ('agent_ops_approved', r.tenant_ops_reviewed_at),
      ('tenant_ops_approved', r.landlord_ops_reviewed_at), ('landlord_ops_approved', r.partner_ops_reviewed_at), ('partner_ops_approved', r.coo_reviewed_at),
      ('coo_approved', r.cfo_reviewed_at)) st(stage, at)
    WHERE r.status = 'completed' AND st.at >= '2026-10-01 00:00 Africa/Kampala'::timestamptz AND st.at < '2026-10-07 00:00 Africa/Kampala'::timestamptz) q;
  out := out || format(E'\nGAPS status=completed: total_gaps=%s independent=%s match=%s | rows all completed=%s', g->>'total', exp_g, (g->>'total')::int = exp_g,
    COALESCE((SELECT bool_and(r->>'current_status' = 'completed') FROM jsonb_array_elements(g->'rows') r), true));

  o := public.awareness_calls_options();
  out := out || format(E'\nOPTIONS callers=%s (%s) regions=%s districts=%s statuses=%s | has region=%s district=%s status=%s  [expect 3 callers]',
    jsonb_array_length(o->'callers'), (SELECT string_agg((r->>'name') || ':' || (r->>'team'), ', ') FROM jsonb_array_elements(o->'callers') r),
    jsonb_array_length(o->'regions'), jsonb_array_length(o->'districts'), jsonb_array_length(o->'statuses'),
    o->'regions' ? reg, EXISTS (SELECT 1 FROM jsonb_array_elements(o->'districts') d WHERE d->>'district' = dist), o->'statuses' ? st_a);

  FOR n IN 1..5 LOOP
    BEGIN
      IF n = 1 THEN PERFORM public.awareness_calls_summary(w_from, w_to, NULL, NULL, NULL, NULL, NULL, 'maybe');
      ELSIF n = 2 THEN PERFORM public.awareness_calls_summary(w_from, w_to, NULL, NULL, NULL, NULL, NULL, NULL, 'aware_30m', NULL);
      ELSIF n = 3 THEN PERFORM public.awareness_calls_summary(w_from, w_to, NULL, NULL, NULL, NULL, NULL, NULL, 'explained', 'knew');
      ELSIF n = 4 THEN PERFORM public.awareness_calls_summary(w_from, w_to, NULL, NULL, NULL, NULL, NULL, NULL, 'aware_30m', 'yes');
      ELSE PERFORM set_config('request.jwt.claim.sub', plain::text, true); PERFORM public.awareness_calls_options();
      END IF;
      out := out || format(E'\nREFUSAL %s: ALLOWED (BAD)', n);
    EXCEPTION WHEN OTHERS THEN out := out || format(E'\nREFUSAL %s: %s', n, SQLERRM);
    END;
  END LOOP;
  out := out || format(E'\nGRANTS options anon/authenticated = %s/%s',
    has_function_privilege('anon','public.awareness_calls_options()','EXECUTE'), has_function_privilege('authenticated','public.awareness_calls_options()','EXECUTE'));
  RAISE EXCEPTION '%', out;
END $$;
