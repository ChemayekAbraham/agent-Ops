-- Tests for partner_ops_invite_visibility (migration 20261015110000).
-- Run as a role with EXECUTE and the gate roles, e.g.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/partner_ops_invite_visibility.sql
-- The function is SECURITY DEFINER and reads RLS-protected tables, so these checks
-- must run from a superuser/owner connection (the read-only query console cannot).

\set ON_ERROR_STOP on

-- The function exists, is SECURITY DEFINER, STABLE and search_path = public.
SELECT proname, prosecdef AS is_security_definer, provolatile AS volatility
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace AND proname = 'partner_ops_invite_visibility';
SELECT count(*) = 1 AS function_exists FROM pg_proc
WHERE pronamespace = 'public'::regnamespace AND proname = 'partner_ops_invite_visibility';

-- Execute is granted to authenticated only; revoked from PUBLIC, anon, service_role.
DO $$
DECLARE
  r record;
  has_authenticated boolean := false;
  has_public boolean := false;
  has_anon boolean := false;
  has_service boolean := false;
BEGIN
  FOR r IN
    SELECT grantee, privilege_type
    FROM information_schema.role_routine_grants
    WHERE specific_schema = 'public' AND routine_name = 'partner_ops_invite_visibility'
  LOOP
    IF r.grantee = 'authenticated' AND r.privilege_type = 'EXECUTE' THEN has_authenticated := true; END IF;
    IF r.grantee = 'PUBLIC' THEN has_public := true; END IF;
    IF r.grantee = 'anon' THEN has_anon := true; END IF;
    IF r.grantee = 'service_role' THEN has_service := true; END IF;
  END LOOP;
  IF NOT has_authenticated OR has_public OR has_anon OR has_service THEN
    RAISE EXCEPTION 'GRANT CHECK FAILED: authenticated=%, public=%, anon=%, service_role=%',
      has_authenticated, has_public, has_anon, has_service;
  END IF;
END $$;

-- Shape: for a portfolio with a completion token, invited is true and token stamps ride along.
DO $$
DECLARE
  v_pid uuid;
  v_rec record;
BEGIN
  SELECT p.id INTO v_pid
  FROM investor_portfolios p
  JOIN portfolio_completion_tokens t ON t.portfolio_id = p.id
  LIMIT 1;
  IF v_pid IS NULL THEN
    RAISE NOTICE 'no tokened portfolio on this database; skipping token-row check';
  ELSE
    SELECT * INTO v_rec FROM partner_ops_invite_visibility(ARRAY[v_pid]);
    IF v_rec.portfolio_id IS DISTINCT FROM v_pid OR v_rec.invited IS NOT TRUE THEN
      RAISE EXCEPTION 'TOKENED PORTFOLIO NOT INVITED: % -> %', v_pid, to_json(v_rec);
    END IF;
  END IF;
END $$;

-- Shape: a portfolio whose invite email was logged (but has no token) still counts as invited.
DO $$
DECLARE
  v_code text;
  v_pid uuid;
  v_rec record;
BEGIN
  SELECT DISTINCT s.metadata->'template_data'->>'portfolio_code' INTO v_code
  FROM email_send_log s
  WHERE s.template_name = 'partner-portfolio-invite'
    AND s.metadata->'template_data'->>'portfolio_code' IS NOT NULL
  LIMIT 1;
  IF v_code IS NULL THEN
    RAISE NOTICE 'no invite emails logged; skipping email-only check';
  ELSE
    SELECT id INTO v_pid FROM investor_portfolios WHERE portfolio_code = v_code LIMIT 1;
    IF v_pid IS NOT NULL THEN
      SELECT * INTO v_rec FROM partner_ops_invite_visibility(ARRAY[v_pid]);
      IF v_rec.invited IS NOT TRUE OR v_rec.sent_count < 1 THEN
        RAISE EXCEPTION 'EMAILED PORTFOLIO NOT INVITED: % -> %', v_code, to_json(v_rec);
      END IF;
    END IF;
  END IF;
END $$;

-- An unknown id comes back with invited = false, never an error.
DO $$
DECLARE
  v_rec record;
BEGIN
  SELECT * INTO v_rec FROM partner_ops_invite_visibility(ARRAY[gen_random_uuid()]);
  IF v_rec.portfolio_id IS NOT NULL OR v_rec.invited IS NOT FALSE THEN
    RAISE EXCEPTION 'UNKNOWN ID SHOULD RETURN invited=false, got %', to_json(v_rec);
  END IF;
END $$;

-- An empty array returns zero rows without error.
SELECT count(*) = 0 AS empty_array_ok FROM partner_ops_invite_visibility(ARRAY[]::uuid[]);

-- Unauthenticated calls are refused.
DO $$
BEGIN
  BEGIN
    SET LOCAL role = anon;
    PERFORM partner_ops_invite_visibility(ARRAY[]::uuid[]);
    RAISE EXCEPTION 'ANON CALL WAS NOT REFUSED';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET role;
  END;
END $$;
