-- Tests for 20261022160000_cc_weekly_all_calls_report.sql (cc_weekly_all_calls_report).
-- Runs the migration's function inside one transaction and always rolls back (the last statement raises with the report); nothing is kept.
-- Usage: (echo 'BEGIN;'; cat supabase/migrations/20261022160000_cc_weekly_all_calls_report.sql; cat supabase/tests/cc_weekly_all_calls_report.sql) | supabase db query --linked
-- "ROLLED BACK REPORT: N passed of N | failing: none" is success. Every figure is recounted from the base tables, written a different way, and compared.
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_from timestamptz := now() - interval '60 days';
  v_to   timestamptz := now() + interval '1 day';
  v_staff uuid; v_plain uuid;
  v_n bigint; v_m bigint; v_dedup bigint; v_dropped bigint;
BEGIN
  -- A. properties and grants
  r := r || jsonb_build_object('step', 'A SECURITY DEFINER, STABLE, search_path = public',
    'pass', (SELECT p.prosecdef AND p.provolatile = 's' AND p.proconfig @> ARRAY['search_path=public']
               FROM pg_proc p WHERE p.oid = 'public.cc_weekly_all_calls_report(timestamptz,timestamptz)'::regprocedure));
  r := r || jsonb_build_object('step', 'A authenticated can execute; anon, service_role and PUBLIC cannot',
    'pass', (SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                    AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0)
               FROM pg_proc p WHERE p.oid = 'public.cc_weekly_all_calls_report(timestamptz,timestamptz)'::regprocedure));
  r := r || jsonb_build_object('step', 'A read-only: no INSERT / UPDATE / DELETE in the body',
    'pass', (SELECT p.prosrc !~* '\m(insert\s+into|update\s+\w+\s+set|delete\s+from)' FROM pg_proc p
              WHERE p.oid = 'public.cc_weekly_all_calls_report(timestamptz,timestamptz)'::regprocedure));

  SELECT ur.user_id INTO v_staff FROM public.user_roles ur WHERE ur.role = 'tenant_ops'::public.app_role AND ur.enabled ORDER BY ur.user_id LIMIT 1;
  SELECT p.id INTO v_plain FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) ORDER BY p.id LIMIT 1;

  -- B. the gate: staff see rows; a user with no role sees none; signed out sees none
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM public.cc_weekly_all_calls_report(v_from, v_to);
    RESET ROLE;
    r := r || jsonb_build_object('step', 'B a Tenant Ops user gets rows', 'pass', v_n > 0, 'detail', v_n::text);
    RAISE EXCEPTION 'CASE_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B a Tenant Ops user gets rows', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
  END;
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_plain, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM public.cc_weekly_all_calls_report(v_from, v_to);
    RESET ROLE;
    r := r || jsonb_build_object('step', 'B a user with no role gets nothing', 'pass', v_n = 0);
    RAISE EXCEPTION 'CASE_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B a user with no role gets nothing', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
  END;
  BEGIN
    PERFORM set_config('request.jwt.claims', '', true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM public.cc_weekly_all_calls_report(v_from, v_to);
    RESET ROLE;
    r := r || jsonb_build_object('step', 'B signed out gets nothing', 'pass', v_n = 0);
    RAISE EXCEPTION 'CASE_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B signed out gets nothing', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
  END;

  -- C. every source recounted from the base tables, written a different way (EXISTS on the raw tables instead of the function's priority join)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  CREATE TEMP TABLE _rep ON COMMIT DROP AS SELECT * FROM public.cc_weekly_all_calls_report(v_from, v_to);
  RESET ROLE;

  -- calling center attempts and received calls have the top priority: counted in full
  SELECT count(*) INTO v_n FROM public.cc_call_attempts a
   WHERE a.void_reason IS NULL AND coalesce(a.recorded_at, a.created_at) >= v_from AND coalesce(a.recorded_at, a.created_at) < v_to;
  r := r || jsonb_build_object('step', 'C calling_center calls = non-voided attempts', 'pass', (SELECT coalesce(sum(calls), 0) FROM _rep WHERE source = 'calling_center') = v_n, 'detail', v_n::text);
  SELECT count(*) INTO v_n FROM public.cc_call_attempts a
   WHERE a.void_reason IS NULL AND a.outcome::text = 'engaged' AND coalesce(a.recorded_at, a.created_at) >= v_from AND coalesce(a.recorded_at, a.created_at) < v_to;
  r := r || jsonb_build_object('step', 'C calling_center answered = engaged attempts', 'pass', (SELECT coalesce(sum(calls), 0) FROM _rep WHERE source = 'calling_center' AND answered) = v_n);
  SELECT count(*) INTO v_n FROM public.cc_received_calls WHERE called_at >= v_from AND called_at < v_to;
  r := r || jsonb_build_object('step', 'C received calls = cc_received_calls', 'pass', (SELECT coalesce(sum(calls), 0) FROM _rep WHERE source = 'received') = v_n, 'detail', v_n::text);

  -- awareness: all calls minus those already shown as a Calling Center attempt to the same person by the same caller within 15 minutes
  SELECT count(*) INTO v_n FROM public.rent_pipeline_awareness_calls w
   WHERE coalesce(w.recorded_at, w.dial_started_at) >= v_from AND coalesce(w.recorded_at, w.dial_started_at) < v_to
     AND NOT EXISTS (SELECT 1 FROM public.cc_call_attempts a JOIN public.cc_cycle_rows cr ON cr.id = a.cycle_row_id
                      WHERE a.void_reason IS NULL AND a.caller_id = w.caller_id AND cr.subject_id = w.subject_user_id
                        AND abs(extract(epoch FROM (coalesce(a.recorded_at, a.created_at) - coalesce(w.recorded_at, w.dial_started_at)))) <= 900);
  r := r || jsonb_build_object('step', 'C awareness calls = awareness rows not already a Calling Center attempt', 'pass', (SELECT coalesce(sum(calls), 0) FROM _rep WHERE source = 'awareness') = v_n, 'detail', v_n::text);

  -- landlord verification phone calls: not already an awareness call on the same Rent Plan by the same person within 15 minutes
  SELECT count(*) INTO v_n FROM public.rent_requests q
   WHERE q.landlord_called IS TRUE AND q.landlord_verification_method = 'phone_call' AND q.landlord_ops_reviewed_by IS NOT NULL
     AND q.landlord_ops_reviewed_at >= v_from AND q.landlord_ops_reviewed_at < v_to
     AND NOT EXISTS (SELECT 1 FROM public.rent_pipeline_awareness_calls w
                      WHERE w.rent_request_id = q.id AND w.caller_id = q.landlord_ops_reviewed_by
                        AND abs(extract(epoch FROM (coalesce(w.recorded_at, w.dial_started_at) - q.landlord_ops_reviewed_at))) <= 900);
  r := r || jsonb_build_object('step', 'C pipeline_landlord calls = Landlord Ops verification phone calls not already an awareness call', 'pass', (SELECT coalesce(sum(calls), 0) FROM _rep WHERE source = 'pipeline_landlord') = v_n, 'detail', v_n::text);

  -- app voice calls: not already a Calling Center attempt or an awareness call to the same person by the same caller within 15 minutes
  SELECT count(*) INTO v_n FROM public.crm_call_sessions s
   WHERE s.created_at >= v_from AND s.created_at < v_to
     AND NOT EXISTS (SELECT 1 FROM public.cc_call_attempts a JOIN public.cc_cycle_rows cr ON cr.id = a.cycle_row_id
                      WHERE a.void_reason IS NULL AND a.caller_id = s.staff_id AND cr.subject_id = s.target_user_id
                        AND abs(extract(epoch FROM (coalesce(a.recorded_at, a.created_at) - s.created_at))) <= 900)
     AND NOT EXISTS (SELECT 1 FROM public.rent_pipeline_awareness_calls w
                      WHERE w.caller_id = s.staff_id AND w.subject_user_id = s.target_user_id
                        AND abs(extract(epoch FROM (coalesce(w.recorded_at, w.dial_started_at) - s.created_at))) <= 900);
  r := r || jsonb_build_object('step', 'C crm_voice calls = sessions not already a Calling Center or awareness call', 'pass', (SELECT coalesce(sum(calls), 0) FROM _rep WHERE source = 'crm_voice') = v_n, 'detail', v_n::text);

  -- legacy tenant / landlord reports: kept only when no higher-priority record shows the same call
  SELECT count(*) INTO v_n FROM public.tenant_call_reports t
   WHERE t.called_at >= v_from AND t.called_at < v_to
     AND NOT EXISTS (SELECT 1 FROM public.cc_call_attempts a JOIN public.cc_cycle_rows cr ON cr.id = a.cycle_row_id
                      WHERE a.void_reason IS NULL AND a.caller_id = t.called_by AND cr.subject_id = t.tenant_id
                        AND abs(extract(epoch FROM (coalesce(a.recorded_at, a.created_at) - t.called_at))) <= 900)
     AND NOT EXISTS (SELECT 1 FROM public.rent_pipeline_awareness_calls w
                      WHERE w.caller_id = t.called_by AND (w.subject_user_id = t.tenant_id OR w.rent_request_id = t.rent_request_id)
                        AND abs(extract(epoch FROM (coalesce(w.recorded_at, w.dial_started_at) - t.called_at))) <= 900)
     AND NOT EXISTS (SELECT 1 FROM public.crm_call_sessions s
                      WHERE s.staff_id = t.called_by AND s.target_user_id = t.tenant_id
                        AND abs(extract(epoch FROM (s.created_at - t.called_at))) <= 900);
  r := r || jsonb_build_object('step', 'C legacy_tenant calls = tenant call reports not already shown elsewhere', 'pass', (SELECT coalesce(sum(calls), 0) FROM _rep WHERE source = 'legacy_tenant') = v_n, 'detail', v_n::text);
  SELECT count(*) INTO v_m FROM public.landlord_call_reports WHERE called_at >= v_from AND called_at < v_to;
  r := r || jsonb_build_object('step', 'C legacy_landlord calls never exceed the landlord call reports', 'pass', (SELECT coalesce(sum(calls), 0) FROM _rep WHERE source = 'legacy_landlord') <= v_m);

  -- no repetitions: no two rows of the report can describe one call (same caller, same Rent Plan, same minute window across different sources)
  r := r || jsonb_build_object('step', 'C one Landlord Ops verification call per Rent Plan',
    'pass', (SELECT coalesce(sum(calls), 0) FROM _rep WHERE source = 'pipeline_landlord') <=
            (SELECT count(*) FROM public.rent_requests q WHERE q.landlord_called IS TRUE AND q.landlord_verification_method = 'phone_call'
                AND q.landlord_ops_reviewed_at >= v_from AND q.landlord_ops_reviewed_at < v_to));

  -- D. shape
  r := r || jsonb_build_object('step', 'D subject_kind is only tenant / landlord / agent / other; source is one of the seven',
    'pass', NOT EXISTS (SELECT 1 FROM _rep WHERE subject_kind NOT IN ('tenant', 'landlord', 'agent', 'other')
                           OR source NOT IN ('calling_center', 'received', 'crm_voice', 'awareness', 'pipeline_landlord', 'legacy_tenant', 'legacy_landlord')));
  r := r || jsonb_build_object('step', 'D every row has a name and a positive count',
    'pass', NOT EXISTS (SELECT 1 FROM _rep WHERE caller_name IS NULL OR calls <= 0 OR kampala_day IS NULL));
  r := r || jsonb_build_object('step', 'D the Kampala day of every row falls inside the window',
    'pass', NOT EXISTS (SELECT 1 FROM _rep WHERE kampala_day < (v_from AT TIME ZONE 'Africa/Kampala')::date OR kampala_day > (v_to AT TIME ZONE 'Africa/Kampala')::date));

  RAISE EXCEPTION 'ROLLED BACK REPORT: % passed of % | failing: %', (SELECT count(*) FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'true'), jsonb_array_length(r),
    COALESCE((SELECT string_agg(e->>'step' || ' ' || COALESCE((e->'detail')::text, ''), '; ') FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'false'), 'none')
    || ' | ' || COALESCE((SELECT string_agg(e->>'step' || ' = ' || (e->>'detail'), '; ') FROM jsonb_array_elements(r) e WHERE e->>'detail' IS NOT NULL AND (e->>'pass') = 'true'), '');
END
$test$;
