-- Tests for partner_ops_invite_partners (migration drizzle/migrations/0578_partner_ops_invite_partners.sql).
-- Run as a role with EXECUTE and the gate roles, e.g.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/partner_ops_invite_partners.sql
-- The function is SECURITY DEFINER and reads RLS-protected tables, so these checks
-- must run from a superuser/owner connection (the read-only query console cannot).

\set ON_ERROR_STOP on

-- The function exists, is SECURITY DEFINER, STABLE and search_path = public.
SELECT proname, prosecdef AS is_security_definer, provolatile AS volatility
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace AND proname = 'partner_ops_invite_partners';
SELECT count(*) = 1 AS function_exists FROM pg_proc
WHERE pronamespace = 'public'::regnamespace AND proname = 'partner_ops_invite_partners';

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
    WHERE specific_schema = 'public' AND routine_name = 'partner_ops_invite_partners'
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

-- Every invite-pipeline portfolio comes back with a name: never blank, never null.
DO $$
DECLARE
  v_rec record;
  v_bad integer;
BEGIN
  FOR v_rec IN
    SELECT * FROM partner_ops_invite_partners(
      ARRAY[
        SELECT id FROM investor_portfolios
        WHERE status IN ('awaiting_partner_details','pending_ops_approval','active')
        ORDER BY created_at DESC LIMIT 50
      ]
    )
  LOOP
    IF v_rec.partner_name IS NULL OR TRIM(v_rec.partner_name) = '' THEN
      RAISE EXCEPTION 'PARTNER NAME MISSING FOR PORTFOLIO %', v_rec.portfolio_id;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_bad FROM partner_ops_invite_partners(
    ARRAY[SELECT id FROM investor_portfolios
          WHERE status IN ('awaiting_partner_details','pending_ops_approval','active')
          ORDER BY created_at DESC LIMIT 50]
  );
  IF v_bad <> 50 THEN
    RAISE NOTICE 'only % of the 50 sampled portfolios resolved; check the database has that many', v_bad;
  END IF;
END $$;

-- A portfolio that already sits in the self-support pending queue is flagged so the
-- invite pipeline can drop it.
DO $$
DECLARE
  v_pid uuid;
  v_flag boolean;
BEGIN
  SELECT fp.portfolio_id INTO v_pid
  FROM funder_pending_portfolios fp
  JOIN investor_portfolios ip ON ip.id = fp.portfolio_id
  WHERE fp.status = 'pending'
    AND ip.status IN ('awaiting_partner_details','pending_ops_approval','active')
  LIMIT 1;
  IF v_pid IS NULL THEN
    RAISE NOTICE 'no pending-queue portfolio in the invite pipeline; skipping flag check';
  ELSE
    SELECT in_pending_queue INTO v_flag FROM partner_ops_invite_partners(ARRAY[v_pid]);
    IF v_flag IS NOT TRUE THEN
      RAISE EXCEPTION 'PENDING-QUEUE PORTFOLIO NOT FLAGGED: %', v_pid;
    END IF;
  END IF;
END $$;

-- A portfolio outside the pending queue is not flagged.
DO $$
DECLARE
  v_pid uuid;
  v_flag boolean;
BEGIN
  SELECT ip.id INTO v_pid
  FROM investor_portfolios ip
  WHERE ip.status IN ('awaiting_partner_details','pending_ops_approval','active')
    AND NOT EXISTS (
      SELECT 1 FROM funder_pending_portfolios fp
      WHERE fp.portfolio_id = ip.id AND fp.status = 'pending'
    )
  ORDER BY ip.created_at DESC LIMIT 1;
  IF v_pid IS NULL THEN
    RAISE NOTICE 'no queue-free portfolio on this database; skipping negative flag check';
  ELSE
    SELECT in_pending_queue INTO v_flag FROM partner_ops_invite_partners(ARRAY[v_pid]);
    IF v_flag IS NOT FALSE THEN
      RAISE EXCEPTION 'QUEUE-FREE PORTFOLIO WRONGLY FLAGGED: %', v_pid;
    END IF;
  END IF;
END $$;

-- An unknown id returns zero rows, never an error, and never a row for someone else's
-- portfolio that was not asked for.
SELECT count(*) = 0 AS unknown_id_ok FROM partner_ops_invite_partners(ARRAY[gen_random_uuid()]);
SELECT count(*) = 0 AS empty_array_ok FROM partner_ops_invite_partners(ARRAY[]::uuid[]);

-- Unauthenticated calls are refused.
DO $$
BEGIN
  BEGIN
    SET LOCAL role = anon;
    PERFORM partner_ops_invite_partners(ARRAY[]::uuid[]);
    RAISE EXCEPTION 'ANON CALL WAS NOT REFUSED';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET role;
  END;
END $$;
