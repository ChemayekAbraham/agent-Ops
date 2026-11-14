-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Option 2, Phase 8: the pilot list. Needs phases 1-8 and phase2_fixture.sql. One transaction, rolled back.

\set ON_ERROR_STOP 1
SET client_min_messages = warning;
BEGIN;
CREATE TEMP TABLE t_results (n serial, name text, ok boolean, detail text);
CREATE FUNCTION pg_temp.check(p_name text, p_ok boolean, p_detail text DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_results (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), p_detail);
$$;
CREATE FUNCTION pg_temp.as_user(p_uid uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', p_uid::text, true);
$$;
\set grace '''11111111-1111-4111-8111-111111111111'''
\set brian '''33333333-3333-4333-8333-333333333333'''

-- The fixture turned both switches on; close option 2 to the pilot list (empty) for this test.
UPDATE pipeline_switches SET is_on = false WHERE key = 'self_support_direct_pay_everyone';
SELECT pg_temp.check('the everyone-switch exists',
  EXISTS (SELECT 1 FROM pipeline_switches WHERE key = 'self_support_direct_pay_everyone'));
SELECT pg_temp.as_user(:grace);
SELECT pg_temp.check('main switch on, pilot empty: not_available',
  direct_pay_claim('a0a0a0a0-0000-4000-8000-000000000001')->>'code' = 'not_available');
INSERT INTO direct_pay_pilot_partners (partner_id, note) VALUES (:grace, 'pilot test');
SELECT pg_temp.check('a pilot partner can claim', direct_pay_claim('a0a0a0a0-0000-4000-8000-000000000001')->>'status' = 'held');
SELECT pg_temp.as_user(:brian);
SELECT pg_temp.check('a partner outside the pilot still cannot',
  direct_pay_claim('a0a0a0a0-0000-4000-8000-000000000003')->>'code' = 'not_available');
UPDATE pipeline_switches SET is_on = true WHERE key = 'self_support_direct_pay_everyone';
-- Brian has no operational float in the fixture, so he gets past the gate and stops at float_short.
SELECT pg_temp.check('everyone-switch on: a partner outside the pilot passes the gate',
  direct_pay_claim('a0a0a0a0-0000-4000-8000-000000000003')->>'code' = 'float_short');
UPDATE pipeline_switches SET is_on = false WHERE key = 'self_support_direct_pay';
SELECT pg_temp.check('main switch off beats everything (even pilot partners)',
  (SELECT direct_pay_claim('a0a0a0a0-0000-4000-8000-000000000005')->>'code' = 'not_available'
     FROM (SELECT pg_temp.as_user(:grace)) u));
SELECT pg_temp.check('the browser cannot read or edit the pilot list',
  NOT has_table_privilege('authenticated', 'direct_pay_pilot_partners', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'direct_pay_pilot_partners', 'INSERT'));

SELECT 'FAIL' AS r, name, detail FROM t_results WHERE NOT ok ORDER BY n;
SELECT 'passed ' || count(*) FILTER (WHERE ok) || ' / ' || count(*) AS summary FROM t_results;
ROLLBACK;
