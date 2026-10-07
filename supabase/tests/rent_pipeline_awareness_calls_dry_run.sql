-- rent_pipeline_awareness_calls: dry run of record_awareness_call / get_awareness_calls_for_request.
-- Everything happens inside one DO block that ends in an exception, so NOTHING is kept (no row, no system_events row).
-- The report is the exception message. Expected:
--   1  recorded: stage = the plan's status, team = agent_ops (the ops test user's strongest team), answers stored
--   2  one system_events row 'rent_pipeline.awareness_call_recorded'
--   3  the same call again returns the stored row (already_recorded = true), still one row
--   4  an unanswered call stores null answers; get_awareness_calls_for_request lists both, newest first, with caller name and team
--   5  refused: answers on an unanswered call, an answered call missing answers, an unknown result, a person who is not the
--      landlord on the plan, a call in the future, 'heard_unsure' (the stored value is 'heard'), an unknown Rent Plan
--   6  UPDATE and DELETE refused (append-only)
--   7  a service centre manager (no staff role) records on their own plan as team service_centre, and is refused elsewhere
--   8  a plain user and a signed-out caller are refused
--   9/10  anon has no table or function access; authenticated can only SELECT (RLS) and EXECUTE the two functions
DO $$
DECLARE
  ops uuid := 'b9078b67-dc4c-473a-bc88-9510d4bcd0dc';
  rr record; sc record; tn uuid; out text := ''; r jsonb; r2 jsonb; g jsonb; n int; ev int;
  t0 timestamptz := now() - interval '2 minutes';
BEGIN
  SELECT r1.id, r1.status, r1.tenant_id, r1.landlord_id, r1.agent_id, p.phone INTO rr
    FROM rent_requests r1 JOIN profiles p ON p.id = r1.tenant_id
   WHERE r1.status = 'repaying' AND p.phone IS NOT NULL AND r1.service_center_manager_id IS NULL LIMIT 1;
  SELECT r1.id, r1.service_center_manager_id, p.phone INTO sc
    FROM rent_requests r1 JOIN profiles p ON p.id = r1.tenant_id
   WHERE r1.status = 'service_center_review' AND r1.service_center_manager_id IS NOT NULL AND p.phone IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = r1.service_center_manager_id AND ur.enabled
                      AND ur.role IN ('tenant_ops','landlord_ops','agent_ops','operations','manager','super_admin','coo','ceo','cto','cfo'))
   LIMIT 1;
  SELECT x.id INTO tn FROM profiles x
   WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = x.id AND ur.enabled AND ur.role NOT IN ('tenant','landlord','agent','supporter'))
   LIMIT 1;

  PERFORM set_config('request.jwt.claim.sub', ops::text, true);
  r := public.record_awareness_call(rr.id, 'tenant', rr.phone, t0, 'answered', rr.tenant_id, 'heard', 'did_not_know', 'partly', 'Dry run: explained the 30M plan.');
  out := out || format(E'\n1 recorded: stage=%s (status %s) team=%s answers=%s/%s/%s', r->>'pipeline_stage', rr.status, r->>'caller_team', r->>'aware_30m', r->>'aware_merchant_codes', r->>'explained');
  SELECT count(*) INTO ev FROM system_events WHERE event_type = 'rent_pipeline.awareness_call_recorded' AND metadata->>'awareness_call_id' = r->>'id';
  out := out || format(E'\n2 system_event rows: %s', ev);
  r2 := public.record_awareness_call(rr.id, 'tenant', rr.phone, t0, 'answered', rr.tenant_id, 'heard', 'did_not_know', 'partly', 'again');
  SELECT count(*) INTO n FROM rent_pipeline_awareness_calls WHERE rent_request_id = rr.id;
  out := out || format(E'\n3 repeat: already_recorded=%s rows=%s', r2->>'already_recorded', n);
  r2 := public.record_awareness_call(rr.id, 'agent', '0700000001', t0 + interval '30 seconds', 'no_answer');
  g := public.get_awareness_calls_for_request(rr.id);
  out := out || format(E'\n4 null answers on no_answer=%s; list total=%s first=%s by %s (%s)', (r2->'aware_30m') = 'null'::jsonb, g->>'total', g->'rows'->0->>'call_result', g->'rows'->0->>'caller_name', g->'rows'->0->>'caller_team');

  FOR n IN 1..7 LOOP
    BEGIN
      IF n = 1 THEN PERFORM public.record_awareness_call(rr.id, 'tenant', rr.phone, t0, 'no_answer', NULL, 'knew', NULL, NULL);
      ELSIF n = 2 THEN PERFORM public.record_awareness_call(rr.id, 'tenant', rr.phone, t0 + interval '1 minute', 'answered', NULL, 'knew', NULL, 'yes');
      ELSIF n = 3 THEN PERFORM public.record_awareness_call(rr.id, 'tenant', rr.phone, t0 + interval '2 minutes', 'maybe');
      ELSIF n = 4 THEN PERFORM public.record_awareness_call(rr.id, 'landlord', rr.phone, t0 + interval '3 minutes', 'no_answer', rr.tenant_id);
      ELSIF n = 5 THEN PERFORM public.record_awareness_call(rr.id, 'tenant', rr.phone, now() + interval '1 hour', 'no_answer');
      ELSIF n = 6 THEN PERFORM public.record_awareness_call(rr.id, 'tenant', rr.phone, t0 + interval '4 minutes', 'answered', NULL, 'heard_unsure', 'knew', 'yes');
      ELSE PERFORM public.record_awareness_call(gen_random_uuid(), 'tenant', rr.phone, t0, 'no_answer');
      END IF;
      out := out || format(E'\n5.%s ALLOWED (BAD)', n);
    EXCEPTION WHEN OTHERS THEN out := out || format(E'\n5.%s refused: %s', n, SQLERRM);
    END;
  END LOOP;

  BEGIN UPDATE rent_pipeline_awareness_calls SET note = 'edited' WHERE id = (r->>'id')::uuid; out := out || E'\n6a UPDATE ALLOWED (BAD)';
  EXCEPTION WHEN OTHERS THEN out := out || format(E'\n6a update refused: %s', SQLERRM); END;
  BEGIN DELETE FROM rent_pipeline_awareness_calls WHERE id = (r->>'id')::uuid; out := out || E'\n6b DELETE ALLOWED (BAD)';
  EXCEPTION WHEN OTHERS THEN out := out || format(E'\n6b delete refused: %s', SQLERRM); END;

  IF sc.id IS NOT NULL THEN
    PERFORM set_config('request.jwt.claim.sub', sc.service_center_manager_id::text, true);
    r2 := public.record_awareness_call(sc.id, 'tenant', sc.phone, t0, 'phone_off');
    out := out || format(E'\n7 service centre manager: team=%s stage=%s', r2->>'caller_team', r2->>'pipeline_stage');
    BEGIN PERFORM public.record_awareness_call(rr.id, 'tenant', rr.phone, t0, 'no_answer'); out := out || E'\n7b other plan ALLOWED (BAD)';
    EXCEPTION WHEN OTHERS THEN out := out || format(E'\n7b other plan refused: %s', SQLERRM); END;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', tn::text, true);
  BEGIN PERFORM public.record_awareness_call(rr.id, 'tenant', rr.phone, t0, 'no_answer'); out := out || E'\n8a plain user ALLOWED (BAD)';
  EXCEPTION WHEN OTHERS THEN out := out || format(E'\n8a plain user refused: %s', SQLERRM); END;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN PERFORM public.get_awareness_calls_for_request(rr.id); out := out || E'\n8b signed-out ALLOWED (BAD)';
  EXCEPTION WHEN OTHERS THEN out := out || format(E'\n8b signed-out refused: %s', SQLERRM); END;

  out := out || format(E'\n9 anon table select/insert/update/delete = %s/%s/%s/%s; authenticated = %s/%s/%s/%s; rls = %s',
    has_table_privilege('anon','public.rent_pipeline_awareness_calls','SELECT'), has_table_privilege('anon','public.rent_pipeline_awareness_calls','INSERT'),
    has_table_privilege('anon','public.rent_pipeline_awareness_calls','UPDATE'), has_table_privilege('anon','public.rent_pipeline_awareness_calls','DELETE'),
    has_table_privilege('authenticated','public.rent_pipeline_awareness_calls','SELECT'), has_table_privilege('authenticated','public.rent_pipeline_awareness_calls','INSERT'),
    has_table_privilege('authenticated','public.rent_pipeline_awareness_calls','UPDATE'), has_table_privilege('authenticated','public.rent_pipeline_awareness_calls','DELETE'),
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rent_pipeline_awareness_calls'::regclass));
  out := out || format(E'\n10 anon execute record/get = %s/%s; authenticated = %s/%s',
    has_function_privilege('anon','public.record_awareness_call(uuid,text,text,timestamptz,text,uuid,text,text,text,text)','EXECUTE'), has_function_privilege('anon','public.get_awareness_calls_for_request(uuid)','EXECUTE'),
    has_function_privilege('authenticated','public.record_awareness_call(uuid,text,text,timestamptz,text,uuid,text,text,text,text)','EXECUTE'), has_function_privilege('authenticated','public.get_awareness_calls_for_request(uuid)','EXECUTE'));
  out := out || format(E'\n11 plan status unchanged: %s', (SELECT status FROM rent_requests WHERE id = rr.id));
  RAISE EXCEPTION '%', out;
END $$;
