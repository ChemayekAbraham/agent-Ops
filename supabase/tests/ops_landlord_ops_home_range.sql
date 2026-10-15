-- Tests for 20261015160000_ops_landlord_ops_home_range.sql (ops_landlord_ops_home_range).
-- One transaction that always rolls back (the last statement raises with the report), so nothing is kept.
-- "ROLLED BACK REPORT: N passed of N | failing: none" is success.
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_U uuid; v_role text; v_ok boolean; v_n int; v_res jsonb; v_exp jsonb; v_w int; v_key text; v_bad text; v_s timestamptz; v_e timestamptz; v_vs timestamptz; v_ve timestamptz;
  v_ll uuid; v_before jsonb; v_after jsonb; v_dp uuid; v_pay uuid; v_rc uuid; v_ph text;
  windows timestamptz[][] := ARRAY[
    [now() - interval '30 days', now()],
    ['2026-10-01T00:00:00+03'::timestamptz, '2026-10-07T12:00:00+03'::timestamptz],
    ['2026-10-12T10:00:00+03'::timestamptz, '2026-10-12T10:30:00+03'::timestamptz]
  ];
BEGIN
  r := r || jsonb_build_object('step', 'A the function is SECURITY DEFINER, STABLE, pinned to search_path = public',
    'pass', (SELECT p.prosecdef AND p.provolatile = 's' AND p.proconfig @> ARRAY['search_path=public'] FROM pg_proc p WHERE p.oid = 'public.ops_landlord_ops_home_range(timestamptz,timestamptz)'::regprocedure));
  r := r || jsonb_build_object('step', 'A authenticated can execute it; anon, service_role and PUBLIC cannot',
    'pass', has_function_privilege('authenticated', 'public.ops_landlord_ops_home_range(timestamptz,timestamptz)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public.ops_landlord_ops_home_range(timestamptz,timestamptz)', 'EXECUTE')
        AND NOT has_function_privilege('service_role', 'public.ops_landlord_ops_home_range(timestamptz,timestamptz)', 'EXECUTE')
        AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = 'public.ops_landlord_ops_home_range(timestamptz,timestamptz)'::regprocedure AND a.grantee = 0));

  SELECT p.id INTO v_U FROM public.profiles p WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) AND p.deleted_at IS NULL ORDER BY md5(p.id::text) LIMIT 1;

  -- who may call
  FOREACH v_role IN ARRAY ARRAY['landlord_ops', 'coo', 'cfo', 'ceo', 'manager', 'super_admin'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (v_U, v_role::public.app_role);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      v_res := public.ops_landlord_ops_home_range(now() - interval '7 days', now());
      RESET ROLE;
      r := r || jsonb_build_object('step', 'B ' || v_role || ' can read it', 'pass', (v_res->>'total_landlords')::int > 0);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B ' || v_role || ' can read it', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
    END;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['tenant_ops', 'agent_ops', 'operations', 'financial_ops', 'cto', 'agent', 'tenant', 'partner_ops'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (v_U, v_role::public.app_role);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      v_ok := false;
      BEGIN PERFORM public.ops_landlord_ops_home_range(now() - interval '7 days', now()); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501' AND SQLERRM = 'not authorised'; END;
      RESET ROLE;
      r := r || jsonb_build_object('step', 'B ' || v_role || ' is refused', 'pass', v_ok);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B ' || v_role || ' is refused', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
    END;
  END LOOP;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
  v_ok := false; BEGIN PERFORM public.ops_landlord_ops_home_range(now() - interval '7 days', now()); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM = 'not authorised'; END;
  r := r || jsonb_build_object('step', 'B a signed-in user with no role is refused', 'pass', v_ok);
  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := false; BEGIN PERFORM public.ops_landlord_ops_home_range(now() - interval '7 days', now()); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501' AND SQLERRM = 'not authorised'; END;
  r := r || jsonb_build_object('step', 'B signed-out (no user) is refused first', 'pass', v_ok);
  BEGIN
    SET LOCAL ROLE anon;
    v_ok := false; BEGIN PERFORM public.ops_landlord_ops_home_range(now() - interval '7 days', now()); EXCEPTION WHEN insufficient_privilege THEN v_ok := true; WHEN OTHERS THEN v_ok := false; END;
    RESET ROLE;
  END;
  r := r || jsonb_build_object('step', 'B the anon role cannot call it (permission denied)', 'pass', v_ok);

  -- from here on: a landlord_ops user
  INSERT INTO public.user_roles (user_id, role) VALUES (v_U, 'landlord_ops'::public.app_role);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);

  -- the range
  v_ok := false; BEGIN PERFORM public.ops_landlord_ops_home_range(NULL, now()); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'RANGE_REQUIRED%'; END;
  r := r || jsonb_build_object('step', 'C a missing start is refused (RANGE_REQUIRED)', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM public.ops_landlord_ops_home_range(now(), NULL); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023'; END;
  r := r || jsonb_build_object('step', 'C a missing end is refused', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM public.ops_landlord_ops_home_range(now(), now() - interval '3 days'); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'RANGE_INVALID%'; END;
  r := r || jsonb_build_object('step', 'C an end before the start is refused (RANGE_INVALID)', 'pass', v_ok);
  v_res := public.ops_landlord_ops_home_range('2026-10-12T10:00:00+03'::timestamptz, '2026-10-12T10:30:00+03'::timestamptz);
  r := r || jsonb_build_object('step', 'C one Kampala day: mid-day times become that whole day (starts 2026-10-11 21:00 UTC, ends 2026-10-12 21:00 UTC, 1 day)',
    'pass', (v_res->>'days')::int = 1 AND (v_res->>'window_start')::timestamptz = '2026-10-12T00:00:00+03'::timestamptz AND (v_res->>'window_end')::timestamptz = '2026-10-13T00:00:00+03'::timestamptz
        AND v_res->>'from_day' = '2026-10-12' AND v_res->>'to_day' = '2026-10-12');
  v_res := public.ops_landlord_ops_home_range('2026-10-01T23:30:00+00'::timestamptz, '2026-10-07T01:00:00+00'::timestamptz);
  r := r || jsonb_build_object('step', 'C Kampala days, not UTC days: 23:30 UTC on 1 Oct is already 2 Oct in Kampala', 'pass', v_res->>'from_day' = '2026-10-02' AND v_res->>'to_day' = '2026-10-07' AND (v_res->>'days')::int = 6);
  v_res := public.ops_landlord_ops_home_range('2026-10-01T10:00:00+03'::timestamptz, '2026-10-07T10:00:00+03'::timestamptz);
  r := r || jsonb_build_object('step', 'C the same day of both ends gives the same answer as midnight to midnight',
    'pass', (SELECT (public.ops_landlord_ops_home_range('2026-10-01T00:00:00+03'::timestamptz, '2026-10-07T23:59:59+03'::timestamptz) - 'generated_at') = (v_res - 'generated_at')));

  -- every figure against an independent recompute, for three windows
  FOR v_w IN 1..3 LOOP
    v_s := windows[v_w][1]; v_e := windows[v_w][2];
    v_vs := (date_trunc('day', (v_s AT TIME ZONE 'Africa/Kampala')) AT TIME ZONE 'Africa/Kampala');
    v_ve := (date_trunc('day', (v_e AT TIME ZONE 'Africa/Kampala')) AT TIME ZONE 'Africa/Kampala') + interval '1 day';
    v_res := public.ops_landlord_ops_home_range(v_s, v_e);
    WITH okl AS (
      SELECT l.*, v.status AS vstatus, v.has_tenant FROM public.landlords l JOIN public.v_landlord_ops_status v ON v.landlord_id = l.id
       WHERE public.normalize_phone_last9(l.phone) IS NULL
          OR public.normalize_phone_last9(l.phone) NOT IN (SELECT public.normalize_phone_last9(p.phone) FROM public.profiles p WHERE p.deleted_at IS NOT NULL AND public.normalize_phone_last9(p.phone) IS NOT NULL)
    ), pay AS (
      SELECT lp.* FROM public.landlord_payouts lp
       WHERE lp.status <> 'failed' AND COALESCE(lp.finops_disbursed_at, lp.disbursed_at) >= v_vs AND COALESCE(lp.finops_disbursed_at, lp.disbursed_at) < v_ve
         AND lp.landlord_id IN (SELECT id FROM okl)
         AND (NOT EXISTS (SELECT 1 FROM public.landlord_payout_receipts r WHERE r.payout_id = lp.id AND r.reversed_at IS NOT NULL)
              OR EXISTS (SELECT 1 FROM public.landlord_payout_receipts r WHERE r.payout_id = lp.id AND r.reversed_at IS NULL))
    ), fun AS (
      SELECT rr.landlord_id, rr.rent_amount FROM public.rent_requests rr WHERE rr.funded_at >= v_vs AND rr.funded_at < v_ve AND rr.landlord_id IN (SELECT id FROM okl)
    ), dups AS (
      SELECT public.normalize_phone_last9(phone) k, count(*) n FROM okl WHERE created_at < v_ve AND public.normalize_phone_last9(phone) IS NOT NULL GROUP BY 1 HAVING count(*) > 1
    )
    SELECT jsonb_build_object(
      'total_landlords', (SELECT count(*) FROM okl WHERE created_at < v_ve),
      'new_landlords', (SELECT count(*) FROM okl WHERE created_at >= v_vs AND created_at < v_ve),
      'verified_landlords', (SELECT count(*) FROM okl WHERE vstatus = 'verified' AND COALESCE(verification_updated_at, created_at) >= v_vs AND COALESCE(verification_updated_at, created_at) < v_ve),
      'houses', (SELECT count(*) FROM public.house_listings h WHERE h.verified = false AND h.status NOT IN ('rejected', 'delisted') AND h.service_center_status IN ('not_required', 'passed')
                   AND (h.landlord_id IS NULL OR h.landlord_id IN (SELECT id FROM okl))),
      'pending_landlords', (SELECT count(*) FROM okl WHERE service_center_status <> 'pending' AND (verified IS NULL OR verified = false)),
      'lc1', (SELECT count(*) FROM public.v_lc1_verification_inbox i WHERE i.service_center_status <> 'pending' AND i.status = 'pending' AND i.agent_request_open = true),
      'with_tenants', (SELECT count(*) FROM okl WHERE created_at < v_ve AND has_tenant),
      'without_tenants', (SELECT count(*) FROM okl WHERE created_at < v_ve AND NOT has_tenant),
      'funded_landlords', (SELECT count(DISTINCT landlord_id) FROM fun),
      'funded_requests', (SELECT count(*) FROM fun),
      'funded_principal', (SELECT COALESCE(sum(rent_amount), 0) FROM fun),
      'landlords_paid', (SELECT count(DISTINCT landlord_id) FROM pay),
      'payouts_paid', (SELECT count(*) FROM pay),
      'paid_amount', (SELECT COALESCE(sum(amount), 0) FROM pay),
      'principal_recovered', (SELECT COALESCE(sum(ia.principal_component), 0) FROM public.instalment_allocations ia WHERE ia.reversed_at IS NULL
                                AND ia.instalment_date >= v_vs AND ia.instalment_date < v_ve
                                AND ia.rent_request_id IN (SELECT rr.id FROM public.rent_requests rr WHERE rr.landlord_id IN (SELECT id FROM okl))),
      'float_balance', (SELECT COALESCE(sum(balance), 0) FROM public.agent_landlord_float WHERE balance > 0),
      'float_agents', (SELECT count(*) FROM public.agent_landlord_float WHERE balance > 0),
      'missing_gps', (SELECT count(*) FROM okl WHERE created_at < v_ve AND (latitude IS NULL OR longitude IS NULL)),
      'missing_payout_details', (SELECT count(*) FROM okl WHERE created_at < v_ve AND btrim(COALESCE(mobile_money_number, '')) = '' AND btrim(COALESCE(bank_name, '')) = ''),
      'duplicate_phones', (SELECT count(*) FROM dups),
      'duplicate_phone_landlords', (SELECT COALESCE(sum(n), 0) FROM dups),
      'excluded_landlords', (SELECT count(*) FROM public.landlords) - (SELECT count(*) FROM okl)
    ) INTO v_exp;
    v_bad := NULL;
    FOREACH v_key IN ARRAY ARRAY['total_landlords', 'new_landlords', 'verified_landlords', 'with_tenants', 'without_tenants', 'funded_landlords', 'funded_requests', 'funded_principal', 'landlords_paid', 'payouts_paid',
                                 'paid_amount', 'principal_recovered', 'float_balance', 'float_agents', 'missing_gps', 'missing_payout_details', 'duplicate_phones', 'duplicate_phone_landlords', 'excluded_landlords'] LOOP
      IF (v_res->>v_key)::numeric IS DISTINCT FROM (v_exp->>v_key)::numeric THEN v_bad := COALESCE(v_bad || ', ', '') || v_key || ' ' || (v_res->>v_key) || ' <> ' || (v_exp->>v_key); END IF;
    END LOOP;
    IF (v_res->'pending_verification'->>'houses')::numeric <> (v_exp->>'houses')::numeric THEN v_bad := COALESCE(v_bad || ', ', '') || 'pending houses'; END IF;
    IF (v_res->'pending_verification'->>'landlords')::numeric <> (v_exp->>'pending_landlords')::numeric THEN v_bad := COALESCE(v_bad || ', ', '') || 'pending landlords'; END IF;
    IF (v_res->'pending_verification'->>'lc1')::numeric <> (v_exp->>'lc1')::numeric THEN v_bad := COALESCE(v_bad || ', ', '') || 'pending lc1'; END IF;
    r := r || jsonb_build_object('step', 'D window ' || v_w || ': all 22 figures equal an independent recompute', 'pass', v_bad IS NULL, 'detail', COALESCE(to_jsonb(v_bad), v_res - 'generated_at'));
  END LOOP;

  r := r || jsonb_build_object('step', 'D every figure is there', 'pass',
    public.ops_landlord_ops_home_range(now() - interval '7 days', now()) ?& ARRAY['total_landlords', 'new_landlords', 'verified_landlords', 'pending_verification', 'with_tenants', 'without_tenants', 'funded_landlords',
      'landlords_paid', 'principal_recovered', 'float_balance', 'missing_gps', 'missing_payout_details', 'duplicate_phones', 'days', 'window_start', 'window_end', 'generated_at']
    AND public.ops_landlord_ops_home_range(now() - interval '7 days', now())->'pending_verification' ?& ARRAY['houses', 'landlords', 'lc1']);
  r := r || jsonb_build_object('step', 'D a wider window never has fewer new landlords, funded landlords or principal recovered than a narrower one inside it',
    'pass', (SELECT (a->>'new_landlords')::int >= (b->>'new_landlords')::int AND (a->>'funded_landlords')::int >= (b->>'funded_landlords')::int AND (a->>'principal_recovered')::numeric >= (b->>'principal_recovered')::numeric
               FROM (SELECT public.ops_landlord_ops_home_range(now() - interval '60 days', now()) a, public.ops_landlord_ops_home_range(now() - interval '7 days', now()) b) x));

  -- E. a landlord whose phone matches a deleted profile is left out of every figure
  SELECT l.id, l.phone INTO v_ll, v_ph FROM public.landlords l
   WHERE EXISTS (SELECT 1 FROM public.rent_requests rr WHERE rr.landlord_id = l.id AND rr.funded_at >= now() - interval '25 days')
     AND public.normalize_phone_last9(l.phone) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE public.normalize_phone_last9(p.phone) = public.normalize_phone_last9(l.phone))
   ORDER BY md5(l.id::text) LIMIT 1;
  SELECT p.id INTO v_dp FROM public.profiles p WHERE p.deleted_at IS NOT NULL ORDER BY md5(p.id::text) LIMIT 1;
  v_before := public.ops_landlord_ops_home_range(now() - interval '30 days', now());
  BEGIN
    UPDATE public.profiles SET phone = v_ph WHERE id = v_dp;
    v_after := public.ops_landlord_ops_home_range(now() - interval '30 days', now());
    r := r || jsonb_build_object('step', 'E a landlord whose phone matches a deleted profile drops out: total -1, excluded +1, funded landlords -1 (they were funded in the window)',
      'pass', (v_after->>'total_landlords')::int = (v_before->>'total_landlords')::int - 1 AND (v_after->>'excluded_landlords')::int = (v_before->>'excluded_landlords')::int + 1
          AND (v_after->>'funded_landlords')::int = (v_before->>'funded_landlords')::int - 1 AND (v_after->>'funded_requests')::int < (v_before->>'funded_requests')::int,
      'detail', jsonb_build_object('before', v_before->'total_landlords', 'after', v_after->'total_landlords'));
    r := r || jsonb_build_object('step', 'E the matching works on the last 9 digits (a +256 or 0 form of the same number is the same number)',
      'pass', public.normalize_phone_last9(v_ph) = public.normalize_phone_last9('+256' || right(regexp_replace(v_ph, '\D', '', 'g'), 9)));
    r := r || jsonb_build_object('step', 'E the float balance is per agent, so it does not change when a landlord is excluded', 'pass', v_after->'float_balance' = v_before->'float_balance');
    RAISE EXCEPTION 'CASE_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'E exclusion case ran', 'pass', false, 'detail', left(SQLERRM, 250)); END IF;
  END;

  -- F. a payout whose only receipt is reversed is not counted as paid
  SELECT lp.id, lp.landlord_id INTO v_pay, v_ll FROM public.landlord_payouts lp
   WHERE lp.status <> 'failed' AND COALESCE(lp.finops_disbursed_at, lp.disbursed_at) >= now() - interval '25 days'
     AND (SELECT count(*) FROM public.landlord_payout_receipts r WHERE r.payout_id = lp.id) = 1
   ORDER BY md5(lp.id::text) LIMIT 1;
  v_before := public.ops_landlord_ops_home_range(now() - interval '30 days', now());
  BEGIN
    UPDATE public.landlord_payout_receipts SET reversed_at = now(), reversal_reason = 'test' WHERE payout_id = v_pay;
    v_after := public.ops_landlord_ops_home_range(now() - interval '30 days', now());
    r := r || jsonb_build_object('step', 'F a payout whose only receipt is reversed is no longer counted: payouts -1 and its amount leaves the total',
      'pass', (v_after->>'payouts_paid')::int = (v_before->>'payouts_paid')::int - 1 AND (v_after->>'paid_amount')::numeric < (v_before->>'paid_amount')::numeric
          AND (v_after->>'landlords_paid')::int <= (v_before->>'landlords_paid')::int);
    RAISE EXCEPTION 'CASE_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'F reversal case ran', 'pass', false, 'detail', left(SQLERRM, 250)); END IF;
  END;

  -- G. read-only, and the model and the other Landlord Ops functions are still there
  r := r || jsonb_build_object('step', 'G the function writes nothing (STABLE) and the existing functions it is modelled on and reuses are untouched and still answer',
    'pass', (SELECT bool_and(p.provolatile = 's') FROM pg_proc p WHERE p.oid IN ('public.ops_tenant_ops_home_range(timestamptz,timestamptz)'::regprocedure, 'public.ops_landlord_funded_stats(timestamptz,timestamptz,text)'::regprocedure,
                                  'public.landlord_ops_float_overview()'::regprocedure, 'public.landlord_ops_principal_comparison(date,date)'::regprocedure, 'public.ops_landlord_status_counts(text,timestamptz,timestamptz)'::regprocedure))
        AND (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'ops_landlord_ops_home_range') = 1);

  RAISE EXCEPTION 'ROLLED BACK REPORT: % passed of % | failing: %', (SELECT count(*) FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'true'), jsonb_array_length(r),
    COALESCE((SELECT string_agg(e->>'step' || ' ' || COALESCE((e->'detail')::text, ''), '; ') FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'false'), 'none');
END
$test$;
