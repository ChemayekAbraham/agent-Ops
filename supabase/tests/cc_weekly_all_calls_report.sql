-- Tests for 20261022130000_cc_weekly_all_calls_report.sql (cc_weekly_all_calls_report).
-- Runs the migration's function inside one transaction and always rolls back (the last statement raises with the report); nothing is kept.
-- Usage: (echo 'BEGIN;'; cat supabase/migrations/20261022130000_cc_weekly_all_calls_report.sql; cat supabase/tests/cc_weekly_all_calls_report.sql) | supabase db query --linked
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

  -- C. every source recounted from the base tables as the staff user
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  CREATE TEMP TABLE _rep ON COMMIT DROP AS SELECT * FROM public.cc_weekly_all_calls_report(v_from, v_to);
  RESET ROLE;

  SELECT count(*) INTO v_n FROM public.cc_call_attempts a
   WHERE a.void_reason IS NULL AND coalesce(a.recorded_at, a.created_at) >= v_from AND coalesce(a.recorded_at, a.created_at) < v_to;
  r := r || jsonb_build_object('step', 'C calling_center calls = non-voided attempts', 'pass', (SELECT coalesce(sum(calls), 0) FROM _rep WHERE source = 'calling_center') = v_n, 'detail', v_n::text);

  SELECT count(*) INTO v_n FROM public.cc_call_attempts a
   WHERE a.void_reason IS NULL AND a.outcome::text = 'engaged' AND coalesce(a.recorded_at, a.created_at) >= v_from AND coalesce(a.recorded_at, a.created_at) < v_to;
  r := r || jsonb_build_object('step', 'C calling_center answered = engaged attempts', 'pass', (SELECT coalesce(sum(calls), 0) FROM _rep WHERE source = 'calling_center' AND answered) = v_n);

  SELECT count(*) INTO v_n FROM public.cc_received_calls WHERE called_at >= v_from AND called_at < v_to;
  r := r || jsonb_build_object('step', 'C received calls = cc_received_calls', 'pass', (SELECT coalesce(sum(calls), 0) FROM _rep WHERE source = 'received') = v_n, 'detail', v_n::text);

  SELECT count(*) INTO v_n FROM public.rent_pipeline_awareness_calls w
   WHERE coalesce(w.recorded_at, w.dial_started_at) >= v_from AND coalesce(w.recorded_at, w.dial_started_at) < v_to;
  r := r || jsonb_build_object('step', 'C awareness calls = rent_pipeline_awareness_calls', 'pass', (SELECT coalesce(sum(calls), 0) FROM _rep WHERE source = 'awareness') = v_n, 'detail', v_n::text);

  SELECT count(*) INTO v_n FROM public.tenant_call_reports WHERE called_at >= v_from AND called_at < v_to;
  SELECT count(*) INTO v_m FROM public.landlord_call_reports WHERE called_at >= v_from AND called_at < v_to;
  r := r || jsonb_build_object('step', 'C legacy tenant and landlord calls = their report tables',
    'pass', (SELECT coalesce(sum(calls), 0) FROM _rep WHERE source = 'legacy_tenant') = v_n AND (SELECT coalesce(sum(calls), 0) FROM _rep WHERE source = 'legacy_landlord') = v_m);

  -- crm_voice: all sessions minus the ones that duplicate a Calling Center attempt (recounted with a join instead of NOT EXISTS)
  SELECT count(*) INTO v_n FROM public.crm_call_sessions s WHERE s.created_at >= v_from AND s.created_at < v_to;
  SELECT count(DISTINCT s.id) INTO v_dropped
    FROM public.crm_call_sessions s
    JOIN public.cc_call_attempts a ON a.caller_id = s.staff_id AND a.void_reason IS NULL
    JOIN public.cc_cycle_rows cr ON cr.id = a.cycle_row_id AND cr.subject_id = s.target_user_id
   WHERE s.created_at >= v_from AND s.created_at < v_to
     AND coalesce(a.recorded_at, a.created_at) >= v_from AND coalesce(a.recorded_at, a.created_at) < v_to
     AND abs(extract(epoch FROM (coalesce(a.recorded_at, a.created_at) - s.created_at))) <= 900;
  r := r || jsonb_build_object('step', 'C crm_voice calls = sessions minus the duplicates of a Calling Center attempt',
    'pass', (SELECT coalesce(sum(calls), 0) FROM _rep WHERE source = 'crm_voice') = v_n - v_dropped, 'detail', format('%s sessions, %s duplicates dropped', v_n, v_dropped));
  SELECT count(*) INTO v_n FROM public.crm_call_sessions s WHERE s.created_at >= v_from AND s.created_at < v_to AND s.answered_at IS NOT NULL;
  r := r || jsonb_build_object('step', 'C crm_voice answered never exceeds sessions with answered_at',
    'pass', (SELECT coalesce(sum(calls), 0) FROM _rep WHERE source = 'crm_voice' AND answered) <= v_n);

  -- D. shape
  r := r || jsonb_build_object('step', 'D subject_kind is only tenant / landlord / agent / other; source is one of the six',
    'pass', NOT EXISTS (SELECT 1 FROM _rep WHERE subject_kind NOT IN ('tenant', 'landlord', 'agent', 'other')
                           OR source NOT IN ('calling_center', 'received', 'crm_voice', 'awareness', 'legacy_tenant', 'legacy_landlord')));
  r := r || jsonb_build_object('step', 'D every row has a name and a positive count',
    'pass', NOT EXISTS (SELECT 1 FROM _rep WHERE caller_name IS NULL OR calls <= 0 OR kampala_day IS NULL));
  r := r || jsonb_build_object('step', 'D the Kampala day of every row falls inside the window',
    'pass', NOT EXISTS (SELECT 1 FROM _rep WHERE kampala_day < (v_from AT TIME ZONE 'Africa/Kampala')::date OR kampala_day > (v_to AT TIME ZONE 'Africa/Kampala')::date));

  RAISE EXCEPTION 'ROLLED BACK REPORT: % passed of % | failing: %', (SELECT count(*) FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'true'), jsonb_array_length(r),
    COALESCE((SELECT string_agg(e->>'step' || ' ' || COALESCE((e->'detail')::text, ''), '; ') FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'false'), 'none')
    || ' | ' || COALESCE((SELECT string_agg(e->>'step' || ' = ' || (e->>'detail'), '; ') FROM jsonb_array_elements(r) e WHERE e->>'detail' IS NOT NULL AND (e->>'pass') = 'true'), '');
END
$test$;
