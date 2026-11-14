-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Option 2 phase 5 tests: the agent records the landlord's signed receipt. Needs phases 1-5 and phase2_fixture.sql.

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
CREATE TEMP TABLE v (k text PRIMARY KEY, j jsonb);
\set grace '''11111111-1111-4111-8111-111111111111'''
\set peter '''55555555-5555-4555-8555-555555555555'''
\set lucy  '''66666666-6666-4666-8666-666666666666'''

SET LOCAL session_replication_role = replica;
INSERT INTO auth.users (id) VALUES (:lucy);
INSERT INTO profiles (id, full_name, email, phone) VALUES (:lucy, 'Lucy', 'lucy@example.test', '0700000006');
INSERT INTO user_roles (user_id, role, enabled) VALUES (:lucy, 'landlord_ops', true);
SET LOCAL session_replication_role = origin;

SELECT pg_temp.as_user(:grace);
INSERT INTO v VALUES ('c', direct_pay_claim('a0a0a0a0-0000-4000-8000-000000000001'));
SELECT direct_pay_record_proof(:grace, (SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'c'), :grace || '/a.jpg', 'sha-a', 'mtn', NULL, NULL,
  jsonb_build_object('status', 'read', 'tid', '1001', 'amount', 500000, 'phone', '0772123456', 'paid_at', (now() + interval '1 minute')::text));
SELECT pg_temp.as_user(:lucy);
INSERT INTO v VALUES ('o', direct_pay_otp_issue(:lucy, (SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'c')));

SELECT pg_temp.as_user(:peter);
SELECT pg_temp.check('before approval the agent cannot record a receipt',
  direct_pay_agent_record_receipt((SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'c'), 'LR-2041')->>'code' = 'not_confirmed');

SELECT pg_temp.as_user(:lucy);
SELECT direct_pay_approve((SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'c'), (SELECT j->>'otp' FROM v WHERE k = 'o'), 'Okello confirmed', NULL);

SELECT pg_temp.as_user(:peter);
INSERT INTO v VALUES ('items', direct_pay_agent_items());
SELECT pg_temp.check('the agent sees the direct-paid plan, its WLR receipt, and that the landlord receipt is missing',
  (SELECT jsonb_array_length(j) = 1 AND (j->0->>'needs_landlord_receipt')::boolean AND j->0->>'receipt_number' LIKE 'WLR-%'
          AND j->0->>'partner_first_name' = 'Grace' FROM v WHERE k = 'items'));
SELECT pg_temp.check('too short a receipt number is refused',
  direct_pay_agent_record_receipt((SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'c'), 'ab')->>'code' = 'receipt_number_invalid');
SELECT pg_temp.check('a photo outside the agent''s folder is refused',
  direct_pay_agent_record_receipt((SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'c'), 'LR-2041', :grace || '/x.jpg')->>'code' = 'invalid_photo');
SELECT pg_temp.check('the agent records it',
  (direct_pay_agent_record_receipt((SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'c'), ' LR-2041 ', :peter || '/lr.jpg')->>'ok')::boolean);
SELECT pg_temp.check('...and it shows as recorded',
  (SELECT NOT (direct_pay_agent_items()->0->>'needs_landlord_receipt')::boolean
          AND direct_pay_agent_items()->0->>'landlord_receipt_number' = 'LR-2041'));
SELECT pg_temp.as_user(:grace);
SELECT pg_temp.check('nobody but the plan''s agent can record it',
  direct_pay_agent_record_receipt((SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'c'), 'LR-9999')->>'code' = 'not_found');
SELECT pg_temp.check('another user''s list is empty', jsonb_array_length(direct_pay_agent_items()) = 0);
SELECT pg_temp.check('anon can call neither',
  NOT has_function_privilege('anon', 'direct_pay_agent_items(integer)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'direct_pay_agent_record_receipt(uuid,text,text)', 'EXECUTE'));

SELECT 'FAIL' AS r, name, detail FROM t_results WHERE NOT ok ORDER BY n;
SELECT 'passed ' || count(*) FILTER (WHERE ok) || ' / ' || count(*) AS summary FROM t_results;
ROLLBACK;
