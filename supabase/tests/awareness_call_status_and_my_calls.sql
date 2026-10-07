-- awareness_call_status_for_requests, my_awareness_calls_summary, my_awareness_calls_log. One DO block that ends in an exception, so
-- NOTHING is kept; the report is the exception message. Controlled calls (times relative to now so they fall in the window):
--   c1 ops (tenant_ops) rra tenant answered at rra's CURRENT stage    c2 ops rra landlord no_answer at an EARLIER stage (service_center_review)
--   c3 x rrb agent answered at rrb's current stage                   c4 x rra tenant no_answer at rra's current stage
-- Expected for the ops caller: rra total 3 / at stage 2 / answered at stage 1 / types {tenant}; rrb 1 / 1 / 1 / {agent}; rrc 0 / 0 / 0 / null / {}.
-- My summary and log count only the caller's own calls (independent count compared); 201 ids and a signed-out user are refused; a non-staff,
-- non-service-centre user is refused; a service centre manager gets only their own Rent Plan.
DO $$
DECLARE
  ops uuid := 'b9078b67-dc4c-473a-bc88-9510d4bcd0dc';
  rra record; rrb record; rrc record; x uuid; plain uuid; scm uuid; rs uuid;
  out text := ''; r record; n int; indep int; s jsonb; lg jsonb; ok boolean;
  w_from timestamptz := now() - interval '2 days'; w_to timestamptz := now();
BEGIN
  SELECT r2.id, r2.tenant_id, r2.status, p.phone INTO rra FROM rent_requests r2 JOIN profiles p ON p.id = r2.tenant_id
   WHERE r2.status <> 'service_center_review' AND p.phone IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM rent_pipeline_awareness_calls c WHERE c.rent_request_id = r2.id) LIMIT 1;
  SELECT r2.id, r2.status INTO rrb FROM rent_requests r2 WHERE r2.id <> rra.id
     AND NOT EXISTS (SELECT 1 FROM rent_pipeline_awareness_calls c WHERE c.rent_request_id = r2.id) LIMIT 1;
  SELECT r2.id INTO rrc FROM rent_requests r2 WHERE r2.id NOT IN (rra.id, rrb.id)
     AND NOT EXISTS (SELECT 1 FROM rent_pipeline_awareness_calls c WHERE c.rent_request_id = r2.id) LIMIT 1;
  SELECT id INTO x FROM profiles WHERE full_name IS NOT NULL AND id <> ops ORDER BY created_at LIMIT 1;
  SELECT x2.id INTO plain FROM profiles x2 WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = x2.id AND ur.enabled AND ur.role NOT IN ('tenant','landlord','agent','supporter'))
     AND NOT EXISTS (SELECT 1 FROM rent_requests q WHERE q.service_center_manager_id = x2.id) LIMIT 1;
  SELECT q.service_center_manager_id, q.id INTO scm, rs FROM rent_requests q
   WHERE q.service_center_manager_id IS NOT NULL AND q.id <> rra.id
     AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = q.service_center_manager_id AND ur.enabled AND ur.role IN ('tenant_ops','landlord_ops','agent_ops','operations','manager','super_admin','coo','ceo','cto','cfo'))
   LIMIT 1;

  INSERT INTO rent_pipeline_awareness_calls (rent_request_id, subject_type, subject_user_id, subject_phone, caller_id, caller_team, pipeline_stage, dial_started_at, call_result, aware_30m, aware_merchant_codes, explained, note) VALUES
   (rra.id, 'tenant',   rra.tenant_id, rra.phone,    ops, 'tenant_ops', rra.status,             now() - interval '3 hours', 'answered',  'knew', 'heard', 'yes', 'c1'),
   (rra.id, 'landlord', NULL,          '0700333444', ops, 'tenant_ops', 'service_center_review', now() - interval '2 hours', 'no_answer', NULL, NULL, NULL, 'c2'),
   (rrb.id, 'agent',    NULL,          '0700555666', x,   'agent_ops',  rrb.status,             now() - interval '1 hour',  'answered',  'heard', 'knew', 'partly', 'c3'),
   (rra.id, 'tenant',   rra.tenant_id, rra.phone,    x,   'agent_ops',  rra.status,             now() - interval '30 minutes', 'no_answer', NULL, NULL, NULL, 'c4');

  PERFORM set_config('request.jwt.claim.sub', ops::text, true);

  SELECT * INTO r FROM public.awareness_call_status_for_requests(ARRAY[rra.id, rrb.id, rrc.id, rra.id]) WHERE rent_request_id = rra.id;
  out := out || format(E'\nRRA total=%s at_stage=%s answered_at_stage=%s types=%s last_call_set=%s  [expect 3 / 2 / 1 / {tenant} / true]', r.calls_total, r.calls_at_current_stage, r.answered_at_current_stage, r.answered_person_types, r.last_call_at IS NOT NULL);
  SELECT * INTO r FROM public.awareness_call_status_for_requests(ARRAY[rra.id, rrb.id, rrc.id]) WHERE rent_request_id = rrb.id;
  out := out || format(E'\nRRB total=%s at_stage=%s answered_at_stage=%s types=%s  [expect 1 / 1 / 1 / {agent}]', r.calls_total, r.calls_at_current_stage, r.answered_at_current_stage, r.answered_person_types);
  SELECT * INTO r FROM public.awareness_call_status_for_requests(ARRAY[rra.id, rrb.id, rrc.id]) WHERE rent_request_id = rrc.id;
  out := out || format(E'\nRRC (no calls) total=%s at_stage=%s answered=%s last_call=%s types=%s  [expect 0 / 0 / 0 / <NULL> / {}]', r.calls_total, r.calls_at_current_stage, r.answered_at_current_stage, coalesce(r.last_call_at::text, '<NULL>'), r.answered_person_types);
  SELECT count(*) INTO n FROM public.awareness_call_status_for_requests(ARRAY[rra.id, rra.id, rrb.id, rrc.id]);
  out := out || format(E'\nONE ROW PER PLAN with a repeated id: %s rows  [expect 3]', n);
  SELECT count(*) INTO n FROM public.awareness_call_status_for_requests(ARRAY[]::uuid[]);
  out := out || format(E' | empty list: %s rows  [expect 0]', n);

  BEGIN
    PERFORM * FROM public.awareness_call_status_for_requests(ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 201)));
    out := out || E'\n201 IDS: NOT refused (unexpected)';
  EXCEPTION WHEN OTHERS THEN out := out || format(E'\n201 IDS refused: %s', SQLERRM);
  END;

  -- my summary / log: only the caller's own calls, compared with an independent count
  s := public.my_awareness_calls_summary(w_from, w_to);
  SELECT count(*) INTO indep FROM rent_pipeline_awareness_calls c WHERE c.caller_id = ops AND c.dial_started_at >= w_from - interval '1 day' AND c.dial_started_at <= w_to + interval '1 day';
  out := out || format(E'\nMY SUMMARY calls=%s answered=%s answered_pct=%s people_called=%s people_reached=%s rent_plans=%s | 30M knew=%s | explained yes=%s  (independent own-call count in window: %s)',
    s->'totals'->>'calls', s->'totals'->>'answered', s->'totals'->>'answered_pct', s->'totals'->>'people_called', s->'totals'->>'people_reached', s->'totals'->>'rent_plans_called',
    s->'aware_30m'->>'knew', s->'explained'->>'yes', indep);
  lg := public.my_awareness_calls_log(w_from, w_to, 50, 0);
  out := out || format(E'\nMY LOG total=%s rows=%s first_note=%s  | none of the rows belong to the other caller: %s',
    lg->>'total', jsonb_array_length(lg->'rows'), lg->'rows'->0->>'note',
    NOT EXISTS (SELECT 1 FROM jsonb_array_elements(lg->'rows') e WHERE e->>'note' IN ('c3', 'c4')));
  out := out || format(E'\nMY LOG page 2 of limit 1: %s row(s), note=%s',
    jsonb_array_length(public.my_awareness_calls_log(w_from, w_to, 1, 1)->'rows'), public.my_awareness_calls_log(w_from, w_to, 1, 1)->'rows'->0->>'note');

  -- the other caller sees only theirs
  PERFORM set_config('request.jwt.claim.sub', x::text, true);
  BEGIN
    s := public.my_awareness_calls_summary(w_from, w_to);
    out := out || format(E'\nOTHER CALLER summary calls=%s (own two: c3, c4)', s->'totals'->>'calls');
  EXCEPTION WHEN OTHERS THEN out := out || format(E'\nOTHER CALLER refused: %s (they hold no ops role in this database)', SQLERRM);
  END;

  -- refusals
  PERFORM set_config('request.jwt.claim.sub', plain::text, true);
  BEGIN PERFORM * FROM public.awareness_call_status_for_requests(ARRAY[rra.id]); out := out || E'\nPLAIN USER status: NOT refused (unexpected)';
  EXCEPTION WHEN OTHERS THEN out := out || format(E'\nPLAIN USER status refused: %s', SQLERRM); END;
  BEGIN PERFORM public.my_awareness_calls_summary(w_from, w_to); out := out || E'\nPLAIN USER my summary: NOT refused (unexpected)';
  EXCEPTION WHEN OTHERS THEN out := out || format(E'\nPLAIN USER my summary refused: %s', SQLERRM); END;
  BEGIN PERFORM public.my_awareness_calls_log(w_from, w_to, 5, 0); out := out || E'\nPLAIN USER my log: NOT refused (unexpected)';
  EXCEPTION WHEN OTHERS THEN out := out || format(E'\nPLAIN USER my log refused: %s', SQLERRM); END;

  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN PERFORM * FROM public.awareness_call_status_for_requests(ARRAY[rra.id]); out := out || E'\nSIGNED OUT: NOT refused (unexpected)';
  EXCEPTION WHEN OTHERS THEN out := out || format(E'\nSIGNED OUT refused: %s', SQLERRM); END;

  -- a service centre manager gets only their own plan
  IF scm IS NOT NULL THEN
    PERFORM set_config('request.jwt.claim.sub', scm::text, true);
    SELECT count(*), COALESCE(bool_and(rent_request_id = rs), false) INTO n, ok FROM public.awareness_call_status_for_requests(ARRAY[rs, rra.id, rrb.id]) ;
    out := out || format(E'\nSERVICE CENTRE MANAGER rows=%s only_own_plan=%s  [expect 1 / true]', n, ok);
  ELSE
    out := out || E'\nSERVICE CENTRE MANAGER: skipped (no manager without a staff role found)';
  END IF;

  RAISE EXCEPTION E'awareness_call_status_and_my_calls report (rolled back, nothing kept):%', out;
END $$;
