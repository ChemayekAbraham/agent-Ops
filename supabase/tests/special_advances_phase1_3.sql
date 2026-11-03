-- Read-only verification for Special Advances phases 1-3:
--   20261028150000_special_advances_calc_engine, 20261028151000_special_advances_storage,
--   20261028152000_special_advances_functions.
--
-- Run it AFTER the three migrations. It only reads: no table, temp table or row is created or written, and it can (and
-- should) run inside BEGIN TRANSACTION READ ONLY. It sets the request's JWT claims for the current transaction only, to
-- call the functions as a signed-in caller. The block ends in RAISE EXCEPTION; the error text IS the report: a JSON
-- list of 8 steps, each with "pass": true/false. Nothing is ever committed.
--
--   1  every object exists: the 3 calculation functions, the 5 tables and the reference sequence, the 8 public functions
--   2  grants: the 8 public functions are callable by authenticated and not by anon; no internal _special_advance_*
--      function is callable by anon or authenticated; the tables are read-only for authenticated and closed to anon;
--      the sequence is closed to both
--   3  row-level security is on for all 5 tables and each has the restrictive staff-MFA policy (mfa_required_for_staff)
--   4  issuance is switched OFF: exactly one settings row, issuance_enabled = false
--   5  callers: no signed-in user -> AUTH_REQUIRED; a signed-in user who is not the CFO -> NOT_AUTHORIZED
--   6  the CFO's quote for a known case (500,000 at 28% a month, 7 days, weekly): no term errors, access fee 32,667,
--      one instalment, the instalments add up to the total, each row adds up, and the quote reports issuance off
--   7  special_advance_create is refused while issuance is off (SPECIAL_ADVANCES_DISABLED), before anything is written
--   8  no Special Advance has been recorded yet (expected straight after the apply; informational on later runs)
DO $verify$
DECLARE
  r jsonb := '[]'::jsonb;
  v_cfo uuid;
  v_ok boolean;
  v_n bigint;
  v_err text;
  v_q jsonb;
  v_s jsonb;
  v_missing text[];
  v_public text[] := ARRAY['special_advance_quote(jsonb)', 'special_advance_create(jsonb)', 'special_advance_get(uuid)',
    'special_advance_list(text,integer,integer)', 'special_advance_approve(uuid,timestamptz,text)',
    'special_advance_reject(uuid,timestamptz,text)', 'special_advance_cancel(uuid,timestamptz,text)', 'special_advance_cfo_ok()'];
  v_tables text[] := ARRAY['special_advances', 'special_advance_instalments', 'special_advance_events',
    'special_advance_external_borrowers', 'special_advance_settings'];
BEGIN
  -- 1
  SELECT array_agg(o) INTO v_missing FROM (
    SELECT unnest(ARRAY['_special_advance_term_errors(numeric,numeric,text,numeric,text,date)',
                        '_special_advance_schedule(numeric,numeric,text,numeric,text,date)',
                        '_special_advance_allocate(jsonb,numeric)'] || v_public) AS o) f
   WHERE to_regprocedure('public.' || o) IS NULL;
  SELECT v_missing || COALESCE(array_agg(t), '{}') INTO v_missing FROM unnest(v_tables || 'special_advance_ref_seq'::text) t
   WHERE to_regclass('public.' || t) IS NULL;
  r := r || jsonb_build_object('step', 1, 'pass', COALESCE(cardinality(v_missing), 0) = 0, 'missing', to_jsonb(COALESCE(v_missing, '{}')));
  IF COALESCE(cardinality(v_missing), 0) > 0 THEN
    -- nothing further can be checked against objects that do not exist
    RAISE EXCEPTION 'special_advances_phase1_3 verification (read only): %', r;
  END IF;

  -- 2
  SELECT array_agg(f) INTO v_missing FROM unnest(v_public) f
   WHERE NOT has_function_privilege('authenticated', 'public.' || f, 'EXECUTE')
      OR has_function_privilege('anon', 'public.' || f, 'EXECUTE');
  SELECT v_missing || COALESCE(array_agg(p.oid::regprocedure::text), '{}') INTO v_missing
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '\_special\_advance\_%'
     AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  SELECT v_missing || COALESCE(array_agg(t), '{}') INTO v_missing FROM unnest(v_tables) t
   WHERE NOT has_table_privilege('authenticated', 'public.' || t, 'SELECT')
      OR has_table_privilege('authenticated', 'public.' || t, 'INSERT') OR has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
      OR has_table_privilege('authenticated', 'public.' || t, 'DELETE')
      OR has_table_privilege('anon', 'public.' || t, 'SELECT') OR has_table_privilege('anon', 'public.' || t, 'INSERT')
      OR has_table_privilege('anon', 'public.' || t, 'UPDATE') OR has_table_privilege('anon', 'public.' || t, 'DELETE');
  IF has_sequence_privilege('anon', 'public.special_advance_ref_seq', 'USAGE')
     OR has_sequence_privilege('authenticated', 'public.special_advance_ref_seq', 'USAGE') THEN
    v_missing := v_missing || 'special_advance_ref_seq'::text;
  END IF;
  r := r || jsonb_build_object('step', 2, 'pass', COALESCE(cardinality(v_missing), 0) = 0, 'wrong_grants', to_jsonb(COALESCE(v_missing, '{}')));

  -- 3
  SELECT array_agg(t) INTO v_missing FROM unnest(v_tables) t
   WHERE NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass)
      OR NOT EXISTS (SELECT 1 FROM pg_policy pol
                      WHERE pol.polrelid = ('public.' || t)::regclass AND pol.polname = 'mfa_required_for_staff'
                        AND NOT pol.polpermissive AND pol.polcmd = '*'
                        AND pol.polroles = ARRAY['authenticated'::regrole::oid]
                        AND pg_get_expr(pol.polqual, pol.polrelid) ~ 'staff_mfa_ok\(\)'
                        AND pg_get_expr(pol.polwithcheck, pol.polrelid) ~ 'staff_mfa_ok\(\)');
  r := r || jsonb_build_object('step', 3, 'pass', COALESCE(cardinality(v_missing), 0) = 0, 'without_rls_or_mfa_policy', to_jsonb(COALESCE(v_missing, '{}')));

  -- 4
  SELECT count(*), bool_and(NOT issuance_enabled) INTO v_n, v_ok FROM public.special_advance_settings;
  r := r || jsonb_build_object('step', 4, 'pass', v_n = 1 AND COALESCE(v_ok, false), 'settings_rows', v_n, 'issuance_off', v_ok);

  -- 5
  v_ok := true;
  -- auth.uid() / auth.jwt() read these first; empty them so the identity below comes only from request.jwt.claims
  PERFORM set_config('request.jwt.claim', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated","aal":"aal2"}', true);
  BEGIN
    PERFORM public.special_advance_quote('{}'::jsonb); v_ok := false; v_err := 'anonymous call was answered';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'AUTH_REQUIRED' THEN v_ok := false; v_err := 'anonymous: ' || SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', '00000000-0000-4000-8000-00000000c0de', 'role', 'authenticated', 'aal', 'aal2')::text, true);
  BEGIN
    PERFORM public.special_advance_quote('{}'::jsonb); v_ok := false; v_err := 'non-CFO call was answered';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'NOT_AUTHORIZED' THEN v_ok := false; v_err := COALESCE(v_err || '; ', '') || 'non-CFO: ' || SQLERRM; END IF;
  END;
  r := r || jsonb_build_object('step', 5, 'pass', v_ok, 'error', v_err);

  -- 6 and 7 run as an enabled CFO (MFA level aal2)
  SELECT ur.user_id INTO v_cfo FROM public.user_roles ur
   WHERE ur.role::text = 'cfo' AND COALESCE(ur.enabled, true) ORDER BY ur.user_id LIMIT 1;
  IF v_cfo IS NULL THEN
    r := r || jsonb_build_object('step', 6, 'pass', false, 'error', 'no enabled CFO found in user_roles')
           || jsonb_build_object('step', 7, 'pass', false, 'error', 'no enabled CFO found in user_roles');
  ELSE
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_cfo, 'role', 'authenticated', 'aal', 'aal2')::text, true);

    -- 6
    v_err := NULL;
    BEGIN
      v_q := public.special_advance_quote(jsonb_build_object('terms', jsonb_build_object(
               'principal', 500000, 'rate_percent', 28, 'rate_basis', 'monthly', 'term_days', 7, 'frequency', 'weekly')));
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
    END;
    v_s := v_q -> 'schedule';
    v_ok := v_err IS NULL
      AND jsonb_array_length(COALESCE(v_q -> 'term_errors', '[]'::jsonb)) = 0
      AND (v_q ->> 'issuance_enabled')::boolean IS FALSE
      AND (v_s ->> 'principal')::bigint = 500000
      AND (v_s ->> 'access_fee')::bigint = 32667
      AND (v_s ->> 'instalments')::int = 1
      AND (SELECT sum((x ->> 'amount')::bigint) FROM jsonb_array_elements(v_s -> 'schedule') x) = (v_s ->> 'total_repayable')::bigint
      AND (SELECT sum((x ->> 'principal')::bigint) FROM jsonb_array_elements(v_s -> 'schedule') x) = 500000
      AND (SELECT bool_and((x ->> 'access_fee')::bigint + (x ->> 'registration_fee')::bigint + (x ->> 'principal')::bigint
                           = (x ->> 'amount')::bigint) FROM jsonb_array_elements(v_s -> 'schedule') x);
    r := r || jsonb_build_object('step', 6, 'pass', COALESCE(v_ok, false), 'error', v_err,
                                 'access_fee', v_s -> 'access_fee', 'registration_fee', v_s -> 'registration_fee',
                                 'total_repayable', v_s -> 'total_repayable', 'instalments', v_s -> 'instalments',
                                 'term_errors', v_q -> 'term_errors', 'issuance_enabled', v_q -> 'issuance_enabled');

    -- 7: a request that passes validation, so only the issuance switch can refuse it (it is refused before any write)
    v_err := NULL;
    BEGIN
      PERFORM public.special_advance_create(jsonb_build_object(
        'idempotency_key', 'verify-phase1-3-read-only-0001',
        'purpose', 'Read-only verification of the issuance switch',
        'borrower', jsonb_build_object('kind', 'welile_user', 'user_id', v_cfo),
        'terms', jsonb_build_object('principal', 500000, 'rate_percent', 28, 'rate_basis', 'monthly', 'term_days', 7, 'frequency', 'weekly')));
      v_err := 'create was not refused';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SPECIAL_ADVANCES_DISABLED' THEN v_err := SQLERRM; END IF;
    END;
    r := r || jsonb_build_object('step', 7, 'pass', v_err IS NULL, 'error', v_err);
  END IF;

  -- 8
  SELECT count(*) INTO v_n FROM public.special_advances;
  r := r || jsonb_build_object('step', 8, 'pass', true, 'special_advances_recorded', v_n,
                               'note', 'expected 0 straight after the apply');

  RAISE EXCEPTION 'special_advances_phase1_3 verification (read only): %', r;
END
$verify$;
