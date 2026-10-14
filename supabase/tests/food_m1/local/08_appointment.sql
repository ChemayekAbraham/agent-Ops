-- Food M1 coordinator appointment suite (Option 2, 2026-10-14).
-- Runs straight after the Food migrations, BEFORE any other suite, in a
-- DISPOSABLE local database. Proves:
--   APPT-01..03  installing Food M1 seats nobody and writes no audit row;
--   APPT-10..14  coordinator-only features are refused while nobody is seated;
--   APPT-20..26  unauthorised / invalid appointments are refused;
--   APPT-30..33  the supported appointment (food_bootstrap_coordinator, run as
--                service_role) succeeds once, and writes an audit record.
-- It finishes by appointing the synthetic stand-in, which the later suites
-- use as their coordinator. No real person is involved.
\set ON_ERROR_STOP 1
SET client_min_messages = notice;
DROP SCHEMA IF EXISTS appt_test CASCADE;
CREATE SCHEMA appt_test;
GRANT USAGE ON SCHEMA appt_test TO anon, authenticated, service_role;

CREATE FUNCTION appt_test.ok(p_cond boolean, p_id text, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(p_cond,false) THEN RAISE NOTICE 'PASS %', p_id;
  ELSE RAISE NOTICE 'FAIL % %', p_id, p_detail; END IF;
END $$;
-- passes only if p_sql raises (any error); reports the message
CREATE FUNCTION appt_test.refused(p_sql text, p_id text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RAISE NOTICE 'FAIL % statement succeeded but should have been refused', p_id;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'PASS % (refused: %)', p_id, SQLERRM;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA appt_test TO anon, authenticated, service_role;

-- synthetic identities: one non-staff account (the stand-in employee comes from the scaffold)
INSERT INTO auth.users(id,email) VALUES ('f0000000-0000-4000-8000-00000000a901','nonstaff@example.invalid');
INSERT INTO public.profiles(id,full_name,email) VALUES ('f0000000-0000-4000-8000-00000000a901','NON STAFF','nonstaff@example.invalid');

-- ── installation ──
SELECT appt_test.ok((SELECT count(*) FROM public.food_coordinator_assignments)=0,
  'APPT-01 installing Food M1 created no coordinator assignment (active or backup)');
SELECT appt_test.ok((SELECT count(*) FROM public.food_audit WHERE entity='coordinator')=0,
  'APPT-02 installing Food M1 wrote no coordinator audit row');
SELECT appt_test.ok(NOT public.is_food_coordinator('29a0cfa8-1eaf-453c-874c-0fc72fa4f74b'),
  'APPT-03 the previously hard-coded person is NOT coordinator after install, though their employee profile exists here');

-- ── coordinator features safely unavailable ──
BEGIN;
SELECT set_config('request.jwt.claims','{"sub":"29a0cfa8-1eaf-453c-874c-0fc72fa4f74b","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
SELECT appt_test.refused($q$SELECT public.food_upsert_meal(NULL,'X',NULL,NULL,1000)$q$, 'APPT-10 menu authoring refused with no coordinator');
SELECT appt_test.refused($q$SELECT public.food_coordinator_overview()$q$, 'APPT-11 coordinator overview refused with no coordinator');
SELECT appt_test.refused($q$SELECT public.food_resolve_exception(gen_random_uuid(),'no coordinator yet')$q$, 'APPT-12 exception resolution refused with no coordinator');
SELECT appt_test.refused($q$SELECT public.food_set_fulfilment(gen_random_uuid(),'preparing')$q$, 'APPT-13 fulfilment changes refused with no coordinator');
SELECT appt_test.refused($q$SELECT public.food_transfer_coordinator('f0000000-0000-4000-8000-00000000a901','full_transfer','self appointment attempt')$q$, 'APPT-14 handover refused when caller is not the active coordinator');
ROLLBACK;

-- ── unauthorised / invalid appointments ──
BEGIN;
SELECT set_config('request.jwt.claims','{"sub":"29a0cfa8-1eaf-453c-874c-0fc72fa4f74b","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
SELECT appt_test.refused($q$SELECT public.food_bootstrap_coordinator('29a0cfa8-1eaf-453c-874c-0fc72fa4f74b','I appoint myself please')$q$, 'APPT-20 signed-in employee cannot appoint themselves');
SELECT appt_test.refused($q$INSERT INTO public.food_coordinator_assignments(coordinator_id,access_level,assigned_by,reason) VALUES ('29a0cfa8-1eaf-453c-874c-0fc72fa4f74b','active',NULL,'direct table write')$q$, 'APPT-21 signed-in employee cannot write the assignment table directly');
ROLLBACK;
BEGIN; SET LOCAL ROLE anon;
SELECT appt_test.refused($q$SELECT public.food_bootstrap_coordinator('29a0cfa8-1eaf-453c-874c-0fc72fa4f74b','anonymous appointment')$q$, 'APPT-22 anonymous caller cannot appoint');
ROLLBACK;
BEGIN; SET LOCAL ROLE service_role;
SELECT appt_test.refused($q$SELECT public.food_bootstrap_coordinator('29a0cfa8-1eaf-453c-874c-0fc72fa4f74b','short')$q$, 'APPT-23 appointment without a 10+ character reason refused');
SELECT appt_test.refused($q$SELECT public.food_bootstrap_coordinator('f0000000-0000-4000-8000-00000000a901','appointing a non-staff account')$q$, 'APPT-24 non-employee account cannot be appointed');
SELECT appt_test.refused($q$SELECT public.food_bootstrap_coordinator(gen_random_uuid(),'appointing an unknown account')$q$, 'APPT-25 unknown account cannot be appointed');
ROLLBACK;
SELECT appt_test.ok((SELECT count(*) FROM public.food_coordinator_assignments)=0,
  'APPT-26 every refused attempt left no assignment behind');

-- ── supported appointment ──
BEGIN; SET LOCAL ROLE service_role;
SELECT appt_test.ok(public.food_bootstrap_coordinator('29a0cfa8-1eaf-453c-874c-0fc72fa4f74b',
  'Test appointment of synthetic stand-in')->>'status'='appointed', 'APPT-30 authorised appointment succeeds');
COMMIT;
SELECT appt_test.ok((SELECT count(*) FROM public.food_coordinator_assignments
                      WHERE revoked_at IS NULL AND access_level='active'
                        AND coordinator_id='29a0cfa8-1eaf-453c-874c-0fc72fa4f74b')=1,
  'APPT-31 exactly one active coordinator after appointment');
SELECT appt_test.ok((SELECT count(*) FROM public.food_audit
                      WHERE entity='coordinator' AND action='bootstrap_appointed'
                        AND entity_id='29a0cfa8-1eaf-453c-874c-0fc72fa4f74b'
                        AND reason='Test appointment of synthetic stand-in')=1,
  'APPT-32 appointment wrote one audit record with its reason');
BEGIN; SET LOCAL ROLE service_role;
SELECT appt_test.refused($q$SELECT public.food_bootstrap_coordinator('29a0cfa8-1eaf-453c-874c-0fc72fa4f74b','second appointment attempt')$q$, 'APPT-33 a second first-appointment is refused once someone is seated');
ROLLBACK;

DROP SCHEMA appt_test CASCADE;
