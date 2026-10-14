-- Rolled-back verification for 20261014160000_tops_smartphone_usage.sql
--
-- Run against the live database. The function is read-only; nothing below changes a row, and the block
-- ends in RAISE EXCEPTION so the error text IS the report (steps with "pass").
--
--   A  access: every staff role _am_staff_ok accepts may read; a user with no staff role and a
--      signed-out call are refused; anon cannot call it; a bad window is refused
--   B  the population is exactly the classification population, and the two splits each add up to it
--   C  a full-history window counts every tenant as joined and every settled device as a check
--   D  a single-day window never exceeds the full-history window (the window really filters)
--   E  nothing else moved: the classification summary is the same before and after this read runs
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_from date := date '2000-01-01';
  v_staff uuid;
  v_plain uuid;
  v_role text;
  v_user uuid;
  v_ok boolean;
  v_msg text;
  v_all jsonb;
  v_day jsonb;
  v_sum jsonb;
  v_before jsonb;
BEGIN
  SELECT user_id INTO v_staff FROM public.user_roles WHERE role = 'tenant_ops' AND enabled LIMIT 1;
  SELECT p.id INTO v_plain FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) LIMIT 1;

  -- A: access ----------------------------------------------------------------------
  FOREACH v_role IN ARRAY ARRAY['manager','super_admin','coo','ceo','cto','cfo','operations','tenant_ops','agent_ops','financial_ops'] LOOP
    SELECT user_id INTO v_user FROM public.user_roles WHERE role::text = v_role AND enabled LIMIT 1;
    IF v_user IS NULL THEN
      r := r || jsonb_build_object('step', 'A staff role ' || v_role, 'pass', NULL, 'detail', 'skipped: no enabled user holds this role');
      CONTINUE;
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
    v_ok := true;
    BEGIN
      PERFORM public.tops_smartphone_usage(v_from, v_today);
    EXCEPTION WHEN OTHERS THEN
      v_ok := false; v_msg := SQLERRM;
    END;
    r := r || jsonb_build_object('step', 'A staff role ' || v_role, 'pass', v_ok, 'detail', COALESCE(v_msg, 'read ' || v_from || ' .. ' || v_today));
    PERFORM set_config('request.jwt.claims', '{}', true);
  END LOOP;

  -- a signed-in user with no staff role is refused
  IF v_plain IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_plain, 'role', 'authenticated')::text, true);
    v_ok := false;
    BEGIN
      PERFORM public.tops_smartphone_usage(v_from, v_today);
    EXCEPTION WHEN insufficient_privilege OR OTHERS THEN
      v_ok := SQLERRM LIKE '%not authorized%';
    END;
    r := r || jsonb_build_object('step', 'A non-staff user refused', 'pass', v_ok);
    PERFORM set_config('request.jwt.claims', '{}', true);
  END IF;

  -- a signed-out call is refused
  PERFORM set_config('request.jwt.claims', '{}', true);
  v_ok := false;
  BEGIN
    PERFORM public.tops_smartphone_usage(v_from, v_today);
  EXCEPTION WHEN OTHERS THEN
    v_ok := SQLERRM LIKE '%not authorized%';
  END;
  r := r || jsonb_build_object('step', 'A signed-out call refused', 'pass', v_ok);

  -- anon has no execute grant at all
  SELECT has_function_privilege('anon', 'public.tops_smartphone_usage(date,date)', 'EXECUTE') INTO v_ok;
  r := r || jsonb_build_object('step', 'A anon has no grant', 'pass', NOT v_ok);
  SELECT has_function_privilege('authenticated', 'public.tops_smartphone_usage(date,date)', 'EXECUTE') INTO v_ok;
  r := r || jsonb_build_object('step', 'A authenticated may call', 'pass', v_ok);

  -- a bad window is refused (as staff)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  FOREACH v_msg IN ARRAY ARRAY['from after to', 'missing day', 'future day'] LOOP
    v_ok := false;
    BEGIN
      IF v_msg = 'from after to' THEN
        PERFORM public.tops_smartphone_usage(v_today, v_from);
      ELSIF v_msg = 'missing day' THEN
        PERFORM public.tops_smartphone_usage(NULL, v_today);
      ELSE
        PERFORM public.tops_smartphone_usage(v_from, v_today + 1);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_ok := SQLERRM NOT LIKE '%not authorized%';
    END;
    r := r || jsonb_build_object('step', 'A refuses ' || v_msg, 'pass', v_ok);
  END LOOP;

  -- B: the population and the two splits -------------------------------------------
  v_before := public.tops_tenant_classification_summary();
  v_all := public.tops_smartphone_usage(v_from, v_today);
  v_sum := public.tops_tenant_classification_summary();

  r := r || jsonb_build_object(
    'step', 'B population is the classification population',
    'pass', (v_all ->> 'tenants')::int = (v_before ->> 'population')::int,
    'detail', 'smartphone ' || (v_all ->> 'tenants') || ' vs classification ' || (v_before ->> 'population'));

  r := r || jsonb_build_object(
    'step', 'B recorded split adds up',
    'pass', ((v_all ->> 'recorded_smartphone')::int + (v_all ->> 'recorded_without')::int) = (v_all ->> 'tenants')::int,
    'detail', (v_all ->> 'recorded_smartphone') || ' with · ' || (v_all ->> 'recorded_without') || ' without');

  r := r || jsonb_build_object(
    'step', 'B confirmed split adds up',
    'pass', ((v_all ->> 'confirmed_smartphone')::int + (v_all ->> 'confirmed_feature_phone')::int + (v_all ->> 'device_unknown')::int) = (v_all ->> 'tenants')::int,
    'detail', (v_all ->> 'confirmed_smartphone') || ' smartphone · ' || (v_all ->> 'confirmed_feature_phone') || ' feature · ' || (v_all ->> 'device_unknown') || ' unknown');

  -- the same segmentation the canonical overview function reports
  r := r || jsonb_build_object(
    'step', 'B matches get_tenant_smartphone_overview',
    'pass', (v_all ->> 'confirmed_smartphone')::int = ((SELECT (s -> 'device' ->> 'confirmed_smartphone')::int
              FROM public.get_tenant_smartphone_overview(NULL, NULL) s))
      AND (v_all ->> 'confirmed_feature_phone')::int = ((SELECT (s -> 'device' ->> 'confirmed_feature_phone')::int
              FROM public.get_tenant_smartphone_overview(NULL, NULL) s)),
    'detail', 'canonical device split vs this read');

  -- C: a full-history window covers everybody ---------------------------------------
  r := r || jsonb_build_object(
    'step', 'C full history counts every tenant as joined',
    'pass', (v_all ->> 'joined')::int = (v_all ->> 'tenants')::int,
    'detail', (v_all ->> 'joined') || ' of ' || (v_all ->> 'tenants'));
  r := r || jsonb_build_object(
    'step', 'C full history counts every settled device',
    'pass', (v_all ->> 'checks')::int = (SELECT count(*) FROM public.profiles p
              WHERE p.deleted_at IS NULL AND p.smartphone_verified_at IS NOT NULL
                AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.role::text = 'tenant' AND ur.enabled)),
    'detail', (v_all ->> 'checks') || ' checks');
  r := r || jsonb_build_object(
    'step', 'C a check concluded something',
    'pass', ((v_all ->> 'checks_smartphone')::int + (v_all ->> 'checks_feature_phone')::int) <= (v_all ->> 'checks')::int,
    'detail', (v_all ->> 'checks_smartphone') || ' smartphone · ' || (v_all ->> 'checks_feature_phone') || ' feature');

  -- D: the window really filters ----------------------------------------------------
  v_day := public.tops_smartphone_usage(v_today, v_today);
  r := r || jsonb_build_object(
    'step', 'D one day never exceeds all time',
    'pass', (v_day ->> 'checks')::int <= (v_all ->> 'checks')::int AND (v_day ->> 'joined')::int <= (v_all ->> 'joined')::int,
    'detail', 'today ' || (v_day ->> 'checks') || ' checks / ' || (v_day ->> 'joined') || ' joined');
  r := r || jsonb_build_object(
    'step', 'D the window is the one asked for',
    'pass', (v_day ->> 'from_day') = v_today::text AND (v_day ->> 'to_day') = v_today::text,
    'detail', (v_day ->> 'from_day') || ' .. ' || (v_day ->> 'to_day'));

  -- E: nothing else moved -----------------------------------------------------------
  r := r || jsonb_build_object(
    'step', 'E classification summary unchanged',
    'pass', v_before = v_sum,
    'detail', 'Active ' || (v_sum ->> 'active') || ' · Waiting ' || (v_sum ->> 'waiting'));

  PERFORM set_config('request.jwt.claims', '{}', true);
  RAISE EXCEPTION E'\n%\n', r;
END;
$test$;
