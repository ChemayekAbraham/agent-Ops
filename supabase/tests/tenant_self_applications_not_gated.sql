-- Rolled-back verification for 20261023150000_tenant_self_applications_not_gated.sql
--
-- Run against the live database. The block ends in RAISE EXCEPTION, so nothing is kept; the error text
-- IS the report. The real rent_requests table has 20+ other insert triggers, so the posting gate is
-- attached to a temporary table with only the three columns it reads, and each insert path is replayed
-- with the caller it really has. Uses an agent the weekly rule blocks and one it passes.
--
--   A  agent signed in, posting for a tenant              -> blocked
--   B  agent signed in, sets tenant_self_applied          -> still blocked (flag not honoured)
--   C  passing agent signed in, sets the flag             -> allowed, flag cleared
--   D  tenant signed in, own request, referrer attached   -> allowed (RentRequestButton / Form)
--   E  service key, tenant_self_applied = true            -> allowed (tenant-self-onboarding)
--   F  service key, flag false                            -> blocked (register-tenant)
--   G  tenant who is also the agent on the row            -> blocked
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_blocked uuid;
  v_passing uuid;
  v_tenant uuid;
  v_flag boolean;
  v_ok boolean;
BEGIN
  UPDATE public.agent_posting_rule_settings SET enforce_weekly = true;

  SELECT agent_id INTO v_blocked FROM public.agent_weekly_posting_eligibility
   WHERE week_start = public._agent_rule_judged_week_start() AND NOT passes LIMIT 1;
  SELECT agent_id INTO v_passing FROM public.agent_weekly_posting_eligibility
   WHERE week_start = public._agent_rule_judged_week_start() AND passes LIMIT 1;
  SELECT p.id INTO v_tenant FROM public.profiles p
   WHERE p.id NOT IN (v_blocked, v_passing) LIMIT 1;

  CREATE TEMP TABLE _rr (agent_id uuid, tenant_id uuid, tenant_self_applied boolean NOT NULL DEFAULT false) ON COMMIT DROP;
  CREATE TRIGGER _gate BEFORE INSERT ON _rr FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_daily_eligibility();

  -- A
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_blocked, 'role', 'authenticated')::text, true);
  BEGIN
    INSERT INTO _rr VALUES (v_blocked, v_tenant, false);
    r := r || jsonb_build_object('step', 'A blocked agent posting -> blocked', 'pass', false);
  EXCEPTION WHEN check_violation THEN
    r := r || jsonb_build_object('step', 'A blocked agent posting -> blocked', 'pass', SQLERRM LIKE 'WEEKLY_ELIGIBILITY_BLOCKED%');
  END;
  -- B
  BEGIN
    INSERT INTO _rr VALUES (v_blocked, v_tenant, true);
    r := r || jsonb_build_object('step', 'B blocked agent setting the flag -> still blocked', 'pass', false);
  EXCEPTION WHEN check_violation THEN
    r := r || jsonb_build_object('step', 'B blocked agent setting the flag -> still blocked', 'pass', true);
  END;
  -- C
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_passing, 'role', 'authenticated')::text, true);
  INSERT INTO _rr VALUES (v_passing, v_tenant, true) RETURNING tenant_self_applied INTO v_flag;
  r := r || jsonb_build_object('step', 'C passing agent setting the flag -> allowed, flag cleared', 'pass', v_flag = false);
  -- D
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_tenant, 'role', 'authenticated')::text, true);
  BEGIN
    INSERT INTO _rr VALUES (v_blocked, v_tenant, false);
    r := r || jsonb_build_object('step', 'D tenant applying in the app, blocked referrer -> allowed', 'pass', true);
  EXCEPTION WHEN check_violation THEN
    r := r || jsonb_build_object('step', 'D tenant applying in the app, blocked referrer -> allowed', 'pass', false, 'detail', SQLERRM);
  END;
  -- E
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  BEGIN
    INSERT INTO _rr VALUES (v_blocked, v_tenant, true) RETURNING tenant_self_applied INTO v_flag;
    r := r || jsonb_build_object('step', 'E self-onboarding (service key + flag), blocked referrer -> allowed, flag kept', 'pass', v_flag);
  EXCEPTION WHEN check_violation THEN
    r := r || jsonb_build_object('step', 'E self-onboarding (service key + flag), blocked referrer -> allowed, flag kept', 'pass', false, 'detail', SQLERRM);
  END;
  -- F
  BEGIN
    INSERT INTO _rr VALUES (v_blocked, v_tenant, false);
    r := r || jsonb_build_object('step', 'F service key without the flag (register-tenant) -> blocked', 'pass', false);
  EXCEPTION WHEN check_violation THEN
    r := r || jsonb_build_object('step', 'F service key without the flag (register-tenant) -> blocked', 'pass', true);
  END;
  -- G
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_blocked, 'role', 'authenticated')::text, true);
  BEGIN
    INSERT INTO _rr VALUES (v_blocked, v_blocked, false);
    r := r || jsonb_build_object('step', 'G blocked agent as their own tenant -> blocked', 'pass', false);
  EXCEPTION WHEN check_violation THEN
    r := r || jsonb_build_object('step', 'G blocked agent as their own tenant -> blocked', 'pass', true);
  END;

  -- The column exists on the real table with a false default.
  SELECT column_default = 'false' AND is_nullable = 'NO' INTO v_ok
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'rent_requests' AND column_name = 'tenant_self_applied';
  r := r || jsonb_build_object('step', 'rent_requests.tenant_self_applied exists, NOT NULL DEFAULT false', 'pass', COALESCE(v_ok, false));

  RAISE EXCEPTION 'REPORT %', r;
END
$test$;
