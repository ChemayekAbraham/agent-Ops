-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Option 2 phase 2 tests: claim, pool, guards, proofs, flags, holds. Needs phase2_fixture.sql.
-- One transaction, rolled back. Prints failures and "passed N / M".

\set ON_ERROR_STOP 1
SET client_min_messages = warning;
BEGIN;

CREATE TEMP TABLE t_results (n serial, name text, ok boolean, detail text);
CREATE FUNCTION pg_temp.check(p_name text, p_ok boolean, p_detail text DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_results (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), p_detail);
$$;
CREATE FUNCTION pg_temp.expect_error(p_name text, p_sql text, p_like text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
    INSERT INTO t_results (name, ok, detail) VALUES (p_name, false, 'expected an error like ' || p_like);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO t_results (name, ok, detail) VALUES (p_name, SQLERRM LIKE p_like, SQLSTATE || ' ' || left(SQLERRM, 140));
  END;
END $$;
CREATE FUNCTION pg_temp.as_user(p_uid uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', p_uid::text, true);
$$;
CREATE FUNCTION pg_temp.plan(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('a0a0a0a0-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$$;

CREATE TEMP TABLE v (k text PRIMARY KEY, j jsonb);
-- Grace = 11.., Brian = 33..
\set grace '''11111111-1111-4111-8111-111111111111'''
\set brian '''33333333-3333-4333-8333-333333333333'''

-- ============================================================ switch
UPDATE pipeline_switches SET is_on = false WHERE key = 'self_support_direct_pay';
SELECT pg_temp.as_user(:grace);
SELECT pg_temp.check('switch off: claim answers not_available',
  direct_pay_claim(pg_temp.plan(1))->>'code' = 'not_available');
UPDATE pipeline_switches SET is_on = true WHERE key = 'self_support_direct_pay';

-- ============================================================ claim
INSERT INTO v VALUES ('c1', direct_pay_claim(pg_temp.plan(1)));
SELECT pg_temp.check('claim: ok and held', (SELECT j->>'ok' = 'true' AND j->>'status' = 'held' FROM v WHERE k = 'c1'), (SELECT j::text FROM v WHERE k = 'c1'));
SELECT pg_temp.check('claim: shows the landlord''s VERIFIED number and name',
  (SELECT j->>'landlord_number' = '+256 772 123456' AND j->>'landlord_name' = 'Okello' FROM v WHERE k = 'c1'));
SELECT pg_temp.check('claim: amount due 500,000, Cover fee 10,000, nothing received yet',
  (SELECT (j->>'amount_due')::numeric = 500000 AND (j->>'cover_fee')::numeric = 10000 AND (j->>'amount_received')::numeric = 0 FROM v WHERE k = 'c1'));
SELECT pg_temp.check('claim: hold ends in 48 hours',
  (SELECT abs(extract(epoch FROM ((j->>'hold_expires_at')::timestamptz - now())) - 172800) < 5 FROM v WHERE k = 'c1'));
SELECT pg_temp.check('claim: tenant first name only',
  (SELECT j->>'tenant_first_name' = 'Musa' FROM v WHERE k = 'c1'));
SELECT pg_temp.check('claim again by the same partner returns the same hold',
  direct_pay_claim(pg_temp.plan(1))->>'payment_id' = (SELECT j->>'payment_id' FROM v WHERE k = 'c1'));
SELECT pg_temp.check('the Cover fee is held on the float (50,000 -> 40,000)',
  funder_float_available(:grace) = 40000, funder_float_available(:grace)::text);

-- ============================================================ the pool
SELECT pg_temp.check('pool: the held plan is gone from v_partner_self_fundable_plans',
  NOT EXISTS (SELECT 1 FROM v_partner_self_fundable_plans WHERE rent_request_id = pg_temp.plan(1)));
SELECT pg_temp.check('pool: the other nine plans are still there',
  (SELECT count(*) FROM v_partner_self_fundable_plans WHERE rent_request_id <> pg_temp.plan(1)) = 9);
SELECT pg_temp.check('stage: direct_pay_held (CFO queues and the company-float fence read this)',
  psm_plan_partner_reserved_stage(pg_temp.plan(1)) = 'direct_pay_held');
SELECT pg_temp.check('psm_reserved_plan_ids returns the held plan once, with its stage',
  (SELECT count(*) = 1 AND min(reserved_stage) = 'direct_pay_held'
     FROM psm_reserved_plan_ids(ARRAY[pg_temp.plan(1), pg_temp.plan(3)])));

SELECT pg_temp.as_user(:brian);
SELECT pg_temp.check('another partner claiming the held plan: taken',
  direct_pay_claim(pg_temp.plan(1))->>'code' = 'taken');
SELECT pg_temp.check('unverified landlord: landlord_not_verified',
  direct_pay_claim(pg_temp.plan(2))->>'code' = 'landlord_not_verified');
SELECT pg_temp.check('no float for the Cover fee: float_short with the amount',
  (SELECT j->>'code' = 'float_short' AND (j->>'float_short')::numeric = 10000 FROM (SELECT direct_pay_claim(pg_temp.plan(4)) j) s));

-- ============================================================ option 1 paths refuse a held plan
SELECT pg_temp.check('wallet claim of a held plan is skipped (reported as lost)',
  (SELECT jsonb_array_length(j->'claimed') = 0 AND j->'lost_to_other_partners' @> to_jsonb(ARRAY[pg_temp.plan(1)])
     FROM (SELECT partner_self_claim_plans(ARRAY[pg_temp.plan(1)], 'p2-test') j) s));
WITH ins AS (INSERT INTO partner_self_plan_claims (rent_request_id, partner_id, amount)
              VALUES (pg_temp.plan(1), :brian, 500000) RETURNING 1)
SELECT pg_temp.check('a raw insert into partner_self_plan_claims for a held plan is skipped, not saved',
  (SELECT count(*) = 0 FROM ins));
SELECT pg_temp.expect_error('co-support invite for a held plan is refused',
  format('INSERT INTO co_support_invites (code, rent_request_id, lead_partner_id, status) VALUES (''T1'', %L, %L, ''open'')', pg_temp.plan(1), :brian),
  'DIRECT_PAY_HELD%');
SELECT pg_temp.expect_error('promissory booking of a held plan is refused',
  format('INSERT INTO promissory_note_plan_intents (rent_request_id, status) VALUES (%L, ''reserved'')', pg_temp.plan(1)),
  'DIRECT_PAY_HELD%');
SELECT pg_temp.expect_error('self-funding line for a held plan is refused',
  format('INSERT INTO partner_self_funding_lines (rent_request_id, partner_id) VALUES (%L, %L)', pg_temp.plan(1), :brian),
  'DIRECT_PAY_HELD%');
SELECT pg_temp.check('wallet claim of a FREE plan still works (guard is quiet)',
  (SELECT jsonb_array_length(j->'claimed') = 1 FROM (SELECT partner_self_claim_plans(ARRAY[pg_temp.plan(9)], 'p2-test-free') j) s));
SELECT pg_temp.check('...and that plan can no longer be claimed for direct pay',
  direct_pay_claim(pg_temp.plan(9))->>'code' = 'taken');

-- ============================================================ proofs (as the edge function would call)
-- Proof 1: read 450,000 from the SMS.
INSERT INTO v VALUES ('p1', direct_pay_record_proof(:grace, (SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'c1'),
  '11111111-1111-4111-8111-111111111111/r1-a.jpg', 'sha-r1-a', 'mtn', NULL, NULL,
  jsonb_build_object('status', 'read', 'tid', 'MP231117.1111', 'amount', 450000, 'phone', '0772123456',
                     'paid_at', (now() + interval '1 minute')::text, 'confidence', 'high')));
SELECT pg_temp.check('short proof: still held, 50,000 short, partner told',
  (SELECT j->>'status' = 'held' AND j->>'code' = 'amount_short' AND (j->>'amount_short')::numeric = 50000 FROM v WHERE k = 'p1'),
  (SELECT j::text FROM v WHERE k = 'p1'));
SELECT pg_temp.check('the partner view never carries the flags',
  (SELECT NOT (j ? 'flags') FROM v WHERE k = 'p1'));
SELECT pg_temp.check('same SMS again (same TID) is refused so it cannot count twice',
  direct_pay_record_proof(:grace, (SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'c1'),
    '11111111-1111-4111-8111-111111111111/r1-a2.jpg', 'sha-other', 'mtn', '231117 1111', NULL,
    '{"status":"read","amount":450000}'::jsonb)->>'code' = 'same_proof_again');
SELECT pg_temp.check('no TID read or typed: tid_missing',
  direct_pay_record_proof(:grace, (SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'c1'),
    '11111111-1111-4111-8111-111111111111/r1-x.jpg', 'sha-x', 'mtn', NULL, NULL, '{"status":"read","amount":50000}'::jsonb)->>'code' = 'tid_missing');
SELECT pg_temp.check('unreadable with no typed amount: amount_missing',
  direct_pay_record_proof(:grace, (SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'c1'),
    '11111111-1111-4111-8111-111111111111/r1-y.jpg', 'sha-y', 'mtn', '9999', NULL, '{"status":"unreadable"}'::jsonb)->>'code' = 'amount_missing');
SELECT pg_temp.check('a photo outside the partner''s folder is refused',
  direct_pay_record_proof(:grace, (SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'c1'),
    '33333333-3333-4333-8333-333333333333/z.jpg', 'sha-z', 'mtn', '7777', 50000, '{"status":"error"}'::jsonb)->>'code' = 'invalid_photo');

-- Proof 2: the reader failed; Grace typed TID and amount.
INSERT INTO v VALUES ('p2', direct_pay_record_proof(:grace, (SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'c1'),
  '11111111-1111-4111-8111-111111111111/r1-b.jpg', 'sha-r1-b', 'mtn', 'MP231117.2222', 50000, '{"status":"error"}'::jsonb));
SELECT pg_temp.check('proofs add up to 500,000: pending (waiting for Landlord Ops)',
  (SELECT j->>'status' = 'pending' AND j->>'ok' = 'true' AND (j->>'amount_received')::numeric = 500000 FROM v WHERE k = 'p2'),
  (SELECT j::text FROM v WHERE k = 'p2'));
SELECT pg_temp.check('flags on the payment: photo_unreadable and number_not_read only',
  (SELECT flags = ARRAY['number_not_read', 'photo_unreadable'] FROM funder_offplatform_rent_payments
    WHERE id = (SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'c1')),
  (SELECT flags::text FROM funder_offplatform_rent_payments WHERE id = (SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'c1')));
SELECT pg_temp.check('a pending payment takes no more proofs',
  direct_pay_record_proof(:grace, (SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'c1'),
    '11111111-1111-4111-8111-111111111111/r1-c.jpg', 'sha-r1-c', 'mtn', '5555', 1000, '{"status":"error"}'::jsonb)->>'code' = 'not_held');
SELECT pg_temp.check('the Cover fee stays held while pending (float still 40,000)',
  funder_float_available(:grace) = 40000);
SELECT pg_temp.as_user(:grace);
SELECT pg_temp.check('pending cannot be released by the partner',
  direct_pay_release((SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'c1'))->>'code' = 'not_held');
SELECT pg_temp.check('the pending plan is still out of the pool',
  NOT EXISTS (SELECT 1 FROM v_partner_self_fundable_plans WHERE rent_request_id = pg_temp.plan(1)));

-- ============================================================ suspicious payment: Brian on R3
-- Brian gets float first so he can claim.
SELECT create_ledger_transaction(jsonb_build_array(
  jsonb_build_object('user_id', :brian, 'amount', 20000, 'direction', 'cash_in', 'category', 'partner_funding',
    'ledger_scope', 'wallet', 'wallet_bucket', 'float', 'recipient_type', 'operational_wallet', 'source_table', 'test', 'description', 'test float'),
  jsonb_build_object('amount', 20000, 'direction', 'cash_out', 'category', 'wallet_deposit', 'ledger_scope', 'platform',
    'source_table', 'test', 'description', 'test cash')), 'p2-test-float-brian');
SELECT pg_temp.as_user(:brian);
INSERT INTO v VALUES ('c3', direct_pay_claim(pg_temp.plan(3)));
SELECT pg_temp.check('Brian holds R3', (SELECT j->>'status' = 'held' FROM v WHERE k = 'c3'), (SELECT j::text FROM v WHERE k = 'c3'));
INSERT INTO v VALUES ('p3', direct_pay_record_proof(:brian, (SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'c3'),
  '33333333-3333-4333-8333-333333333333/r3.jpg', 'sha-r1-a', 'airtel', NULL, NULL,
  jsonb_build_object('status', 'read', 'tid', '3333 3333', 'amount', 550000, 'phone', '0701555666',
                     'paid_at', (now() - interval '3 days')::text, 'confidence', 'high')));
SELECT pg_temp.check('suspicious proof still goes to Landlord Ops (pending), nothing auto-rejected',
  (SELECT j->>'status' = 'pending' FROM v WHERE k = 'p3'), (SELECT j::text FROM v WHERE k = 'p3'));
SELECT pg_temp.check('flags: tid_used_before, paid_before_hold, wrong_number, same_photo, paid_more',
  (SELECT flags @> ARRAY['tid_used_before', 'paid_before_hold', 'wrong_number', 'same_photo', 'paid_more']
          AND NOT flags && ARRAY['number_not_read', 'photo_unreadable']
     FROM funder_offplatform_rent_payments WHERE id = (SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'c3')),
  (SELECT flags::text FROM funder_offplatform_rent_payments WHERE id = (SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'c3')));

-- ============================================================ limits, expiry, release
SELECT pg_temp.as_user(:grace);
SELECT pg_temp.check('Grace holds R5', direct_pay_claim(pg_temp.plan(5))->>'status' = 'held');
SELECT pg_temp.check('Grace holds R6', direct_pay_claim(pg_temp.plan(6))->>'status' = 'held');
SELECT pg_temp.check('Grace holds R7', direct_pay_claim(pg_temp.plan(7))->>'status' = 'held');
SELECT pg_temp.check('a 4th live hold is refused (too_many_holds)', direct_pay_claim(pg_temp.plan(8))->>'code' = 'too_many_holds');

-- (each action and its check are separate statements: one statement sees one snapshot)
SELECT pg_temp.check('release before any proof: the hold ends',
  (SELECT j->>'status' = 'expired' FROM (SELECT direct_pay_release((SELECT id FROM funder_offplatform_rent_payments
     WHERE rent_request_id = pg_temp.plan(6) AND flow = 'direct_pay')) j) s));
SELECT pg_temp.check('after release the plan is back in the pool',
  EXISTS (SELECT 1 FROM v_partner_self_fundable_plans WHERE rent_request_id = pg_temp.plan(6)));

UPDATE funder_offplatform_rent_payments SET hold_started_at = now() - interval '49 hours', hold_expires_at = now() - interval '1 hour'
 WHERE rent_request_id = pg_temp.plan(5) AND flow = 'direct_pay';
SELECT pg_temp.check('a hold past 48 hours is back in the pool even before the job runs',
  EXISTS (SELECT 1 FROM v_partner_self_fundable_plans WHERE rent_request_id = pg_temp.plan(5)));
SELECT pg_temp.check('refresh on an ended hold: hold_ended, status expired',
  (SELECT j->>'code' = 'hold_ended' AND j->>'status' = 'expired' FROM (SELECT direct_pay_refresh((SELECT id FROM funder_offplatform_rent_payments
     WHERE rent_request_id = pg_temp.plan(5) AND flow = 'direct_pay')) j) s));
SELECT pg_temp.check('the ended hold''s Cover fee is waived (no longer held)',
  (SELECT cover_fee_status = 'waived' FROM funder_offplatform_rent_payments WHERE rent_request_id = pg_temp.plan(5) AND flow = 'direct_pay'));
SELECT pg_temp.check('float after: 50,000 - R1 (pending) - R7 (held) = 30,000',
  funder_float_available(:grace) = 30000, funder_float_available(:grace)::text);
SELECT pg_temp.check('my payments: live first, all four of Grace''s listed, no flags',
  (SELECT jsonb_array_length(j) = 4 AND j->0->>'status' IN ('held', 'pending') AND NOT (j->0 ? 'flags')
     FROM (SELECT direct_pay_my_payments() j) s));
SELECT pg_temp.check('another partner cannot read or release Grace''s payment',
  (SELECT direct_pay_release(id)->>'code' = 'not_found' AND direct_pay_refresh(id)->>'code' = 'not_found'
     FROM (SELECT id FROM funder_offplatform_rent_payments WHERE rent_request_id = pg_temp.plan(7) AND flow = 'direct_pay') s
     CROSS JOIN LATERAL (SELECT pg_temp.as_user(:brian)) u));

-- ============================================================ who may call what
SELECT pg_temp.check('the browser cannot call direct_pay_record_proof',
  NOT has_function_privilege('authenticated', 'direct_pay_record_proof(uuid,uuid,text,text,text,text,numeric,jsonb)', 'EXECUTE'));
SELECT pg_temp.check('the browser can call claim, release, refresh, my payments',
  has_function_privilege('authenticated', 'direct_pay_claim(uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'direct_pay_release(uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'direct_pay_refresh(uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'direct_pay_my_payments()', 'EXECUTE'));
SELECT pg_temp.check('anon can call none of them',
  NOT has_function_privilege('anon', 'direct_pay_claim(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'direct_pay_my_payments()', 'EXECUTE'));
SELECT pg_temp.check('internal helpers are closed to the browser',
  NOT has_function_privilege('authenticated', '_direct_pay_evaluate(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', '_direct_pay_flags(uuid)', 'EXECUTE'));

-- ============================================================ report
SELECT 'FAIL' AS r, name, detail FROM t_results WHERE NOT ok ORDER BY n;
SELECT 'passed ' || count(*) FILTER (WHERE ok) || ' / ' || count(*) AS summary FROM t_results;
ROLLBACK;
