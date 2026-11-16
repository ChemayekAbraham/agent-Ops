-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Option 2, Phase 7: failure tests (local copy only, never production). Each test breaks ONE thing on purpose
-- (a function replaced inside a savepoint, a clock moved, a switch flipped) and checks the system stays correct.
-- Needs phases 1-7 and phase2_fixture.sql. One transaction, rolled back.

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
CREATE FUNCTION pg_temp.plan(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('a0a0a0a0-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$$;
CREATE TEMP TABLE v (k text PRIMARY KEY, j jsonb);
CREATE FUNCTION pg_temp.pid(p_k text) RETURNS uuid LANGUAGE sql AS $$ SELECT (j->>'payment_id')::uuid FROM v WHERE k = p_k $$;
-- Claim plan n as a partner and bring it to 'pending' with one full proof.
CREATE FUNCTION pg_temp.pending(p_k text, p_partner uuid, n int, p_tid text) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_partner::text, true);
  INSERT INTO v VALUES (p_k, direct_pay_claim(pg_temp.plan(n)));
  PERFORM direct_pay_record_proof(p_partner, pg_temp.pid(p_k), p_partner::text || '/' || p_k || '.jpg', 'sha-' || p_k, 'mtn', NULL, NULL,
    jsonb_build_object('status', 'read', 'tid', p_tid, 'amount', 500000, 'phone', '0772123456', 'paid_at', (now() + interval '1 minute')::text));
  RETURN pg_temp.pid(p_k);
END $$;
CREATE FUNCTION pg_temp.otp(p_payment uuid) RETURNS text LANGUAGE sql AS $$
  SELECT direct_pay_otp_issue('66666666-6666-4666-8666-666666666666', p_payment)->>'otp'
$$;

\set grace '''11111111-1111-4111-8111-111111111111'''
\set brian '''33333333-3333-4333-8333-333333333333'''
\set lucy  '''66666666-6666-4666-8666-666666666666'''
\set sam   '''88888888-8888-4888-8888-888888888888'''

SET LOCAL session_replication_role = replica;
INSERT INTO auth.users (id, email) VALUES (:lucy, 'lucy@example.test'), (:sam, 'sam@example.test');
UPDATE auth.users SET email = 'peter@example.test' WHERE id = '55555555-5555-4555-8555-555555555555';
INSERT INTO profiles (id, full_name, email, phone) VALUES (:lucy, 'Lucy', 'lucy@example.test', '0700000006'), (:sam, 'Sam', 'sam@example.test', '0700000008');
INSERT INTO user_roles (user_id, role, enabled) VALUES (:lucy, 'landlord_ops', true), (:sam, 'agent', true);
INSERT INTO commission_fund_ins (fund_in_key, partner_id, source_table, source_id, amount, occurred_at, status, earner_id, earner_path)
VALUES ('test:brian-first', :brian, 'test', gen_random_uuid(), 100000, now() - interval '30 days', 'paid', :sam, 'promissory_note');
INSERT INTO vault.decrypted_secrets (name, decrypted_secret) VALUES ('email_queue_service_role_key', 'test-key') ON CONFLICT DO NOTHING;
SET LOCAL session_replication_role = origin;
SELECT create_ledger_transaction(jsonb_build_array(
  jsonb_build_object('user_id', :brian, 'amount', 30000, 'direction', 'cash_in', 'category', 'partner_funding',
    'ledger_scope', 'wallet', 'wallet_bucket', 'float', 'recipient_type', 'operational_wallet', 'source_table', 'test', 'description', 'test float'),
  jsonb_build_object('amount', 30000, 'direction', 'cash_out', 'category', 'wallet_deposit', 'ledger_scope', 'platform',
    'source_table', 'test', 'description', 'test cash')), 'p7-test-float-brian');

-- ============================================================ F1: approval fails halfway -> nothing at all is saved
SELECT pg_temp.pending('f1', :brian, 3, '7001');
SELECT pg_temp.as_user(:lucy);
INSERT INTO v VALUES ('f1otp', jsonb_build_object('otp', pg_temp.otp(pg_temp.pid('f1'))));
SAVEPOINT f1;
-- Break the last money step (the receipt) so the failure comes after the portfolio, ledger, fee and agent pay.
CREATE OR REPLACE FUNCTION public._direct_pay_issue_receipt(p_payment_id uuid, p_staff uuid) RETURNS public.landlord_payout_receipts
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected: receipt service down'; END $$;
DO $$
BEGIN
  PERFORM direct_pay_approve((SELECT (j->>'payment_id')::uuid FROM v WHERE k = 'f1'), (SELECT j->>'otp' FROM v WHERE k = 'f1otp'),
                             'Okello confirmed', NULL);
  INSERT INTO t_results (name, ok, detail) VALUES ('F1: the broken approval raised', false, 'it succeeded');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO t_results (name, ok, detail) VALUES ('F1: the broken approval raised', SQLERRM LIKE 'injected%', SQLERRM);
END $$;
SELECT pg_temp.check('F1: payment still pending, proof still submitted, OTP still usable',
  (SELECT status = 'pending' AND portfolio_id IS NULL AND landlord_otp_verified_at IS NULL FROM funder_offplatform_rent_payments WHERE id = pg_temp.pid('f1'))
  AND NOT EXISTS (SELECT 1 FROM funder_offplatform_rent_proofs WHERE payment_id = pg_temp.pid('f1') AND status <> 'submitted')
  AND EXISTS (SELECT 1 FROM direct_pay_landlord_otps WHERE payment_id = pg_temp.pid('f1') AND status IN ('issued', 'sent')));
SELECT pg_temp.check('F1: no portfolio, no commitment, no ledger line, no agent pay, no message',
  NOT EXISTS (SELECT 1 FROM partner_self_commitments WHERE idempotency_key = 'direct-pay-' || pg_temp.pid('f1')::text)
  AND NOT EXISTS (SELECT 1 FROM general_ledger WHERE source_id = pg_temp.pid('f1') OR idempotency_key IN
                    ('direct-pay-' || pg_temp.pid('f1')::text, 'opcover-' || pg_temp.pid('f1')::text, 'direct-pay-commission-' || pg_temp.pid('f1')::text))
  AND NOT EXISTS (SELECT 1 FROM self_support_notices WHERE ref_id = pg_temp.pid('f1') AND event = 'dp_approved'));
SELECT pg_temp.check('F1: the Rent Plan is untouched (not funded, not repaying)',
  (SELECT funded_at IS NULL AND status = 'coo_approved' FROM rent_requests WHERE id = pg_temp.plan(3)));
ROLLBACK TO SAVEPOINT f1;   -- the receipt service is back
SELECT pg_temp.check('F1: once the fault is gone the same approval succeeds',
  (direct_pay_approve(pg_temp.pid('f1'), (SELECT j->>'otp' FROM v WHERE k = 'f1otp'), 'Okello confirmed', NULL)->>'ok')::boolean);

-- ============================================================ F2: email provider down at approval
SELECT pg_temp.pending('f2', :grace, 1, '7002');
SELECT pg_temp.as_user(:lucy);
INSERT INTO v VALUES ('f2otp', jsonb_build_object('otp', pg_temp.otp(pg_temp.pid('f2'))));
SAVEPOINT f2;
-- The branded receipt email (pg_net) and the plain email queue both fail.
CREATE OR REPLACE FUNCTION public._direct_pay_agent_receipt_email(p_payment_id uuid) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected: pg_net down'; END $$;
DO $$
BEGIN
  EXECUTE (SELECT 'CREATE OR REPLACE FUNCTION public.enqueue_email(queue_name text, payload jsonb) RETURNS '
                  || pg_get_function_result('public.enqueue_email'::regproc)
                  || ' LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION ''injected: email queue down''; END $f$');
END $$;
INSERT INTO v VALUES ('f2a', direct_pay_approve(pg_temp.pid('f2'), (SELECT j->>'otp' FROM v WHERE k = 'f2otp'), 'Okello confirmed', 'blurry photo, landlord read the TID'));
SELECT pg_temp.check('F2: approval still saved with email down', (SELECT (j->>'ok')::boolean FROM v WHERE k = 'f2a'), (SELECT j::text FROM v WHERE k = 'f2a'));
SELECT pg_temp.check('F2: every approval SMS is still queued (partner, agent, tenant)',
  (SELECT count(DISTINCT audience) FROM self_support_notices WHERE ref_id = pg_temp.pid('f2') AND event = 'dp_approved' AND channel = 'sms') = 3);
SELECT pg_temp.check('F2: the agent receipt email is not marked as sent',
  (SELECT agent_email_requested_at IS NULL FROM funder_offplatform_rent_payments WHERE id = pg_temp.pid('f2')));
SELECT pg_temp.check('F2: no email rows were half-written',
  NOT EXISTS (SELECT 1 FROM self_support_notices WHERE ref_id = pg_temp.pid('f2') AND event = 'dp_approved' AND channel = 'email'));
ROLLBACK TO SAVEPOINT f2;

-- ============================================================ F3: the reader is down (proof saved, flagged, never an error)
SELECT pg_temp.as_user(:grace);
INSERT INTO v VALUES ('f3', direct_pay_claim(pg_temp.plan(5)));
INSERT INTO v VALUES ('f3r', direct_pay_record_proof(:grace, pg_temp.pid('f3'), :grace || '/f3.jpg', 'sha-f3', 'mtn', '7003', 500000,
                                                      '{"status":"error","reason":"reader_timeout"}'::jsonb));
SELECT pg_temp.check('F3: reader down: proof saved, payment goes to Landlord Ops, flagged unreadable',
  (SELECT j->>'status' = 'pending' FROM v WHERE k = 'f3r')
  AND (SELECT 'photo_unreadable' = ANY (flags) FROM funder_offplatform_rent_payments WHERE id = pg_temp.pid('f3')));

-- ============================================================ F4: expiry job late and run twice
SELECT pg_temp.as_user(:grace);
INSERT INTO v VALUES ('f4', direct_pay_claim(pg_temp.plan(6)));
UPDATE funder_offplatform_rent_payments SET hold_started_at = now() - interval '7 days', hold_expires_at = now() - interval '5 days'
 WHERE id = pg_temp.pid('f4');
SELECT pg_temp.check('F4: a hold 5 days past its end is still out of reach (no proof can be added)',
  direct_pay_record_proof(:grace, pg_temp.pid('f4'), :grace || '/late.jpg', 'sha-late', 'mtn', '7004', 500000, '{"status":"error"}'::jsonb)->>'code' = 'hold_ended');
SELECT direct_pay_tick();
SELECT direct_pay_tick();
SELECT pg_temp.check('F4: ended once, one "hold ended" message, plan back in the pool',
  (SELECT count(*) FROM self_support_notices WHERE ref_id = pg_temp.pid('f4') AND event = 'dp_hold_ended' AND channel = 'sms') = 1
  AND (SELECT status = 'expired' FROM funder_offplatform_rent_payments WHERE id = pg_temp.pid('f4'))
  AND EXISTS (SELECT 1 FROM v_partner_self_fundable_plans WHERE rent_request_id = pg_temp.plan(6)));

-- ============================================================ F5: switch turned off while partners are mid-payment
SELECT pg_temp.as_user(:grace);
INSERT INTO v VALUES ('f5', direct_pay_claim(pg_temp.plan(7)));
UPDATE pipeline_switches SET is_on = false WHERE key = 'self_support_direct_pay';
SELECT pg_temp.check('F5: switch off: no new claims',
  direct_pay_claim(pg_temp.plan(8))->>'code' = 'not_available');
SELECT pg_temp.check('F5: ...but a partner already holding a plan can still hand in their SMS (they may have paid)',
  direct_pay_record_proof(:grace, pg_temp.pid('f5'), :grace || '/f5.jpg', 'sha-f5', 'mtn', NULL, NULL,
    jsonb_build_object('status', 'read', 'tid', '7005', 'amount', 500000, 'phone', '0772123456', 'paid_at', (now() + interval '1 minute')::text))->>'status' = 'pending');
SELECT pg_temp.as_user(:lucy);
SELECT pg_temp.check('F5: ...and Landlord Ops can still approve it',
  (direct_pay_approve(pg_temp.pid('f5'), pg_temp.otp(pg_temp.pid('f5')), 'Okello confirmed', NULL)->>'ok')::boolean);
UPDATE pipeline_switches SET is_on = true WHERE key = 'self_support_direct_pay';

-- ============================================================ F6: the float runs short before approval, then is topped up
SELECT pg_temp.pending('f6', :brian, 9, '7006');
-- Brian's float drained below the fee by a test leg that ignores holds (the worst case).
SELECT create_ledger_transaction(jsonb_build_array(
  jsonb_build_object('user_id', :brian, 'amount', (SELECT get_user_float_available_balance(:brian)) - 1000, 'direction', 'cash_out',
    'category', 'partner_funding', 'ledger_scope', 'wallet', 'wallet_bucket', 'float', 'recipient_type', 'operational_wallet',
    'source_table', 'test', 'description', 'test drain'),
  jsonb_build_object('amount', (SELECT get_user_float_available_balance(:brian)) - 1000, 'direction', 'cash_in', 'category', 'partner_funding',
    'ledger_scope', 'platform', 'source_table', 'test', 'description', 'test drain')), 'p7-test-drain');
SELECT pg_temp.as_user(:lucy);
INSERT INTO v VALUES ('f6a', direct_pay_approve(pg_temp.pid('f6'), pg_temp.otp(pg_temp.pid('f6')), 'Okello confirmed', NULL));
SELECT pg_temp.check('F6: float short at approval: the portfolio still activates, the fee waits for a top-up',
  (SELECT (j->>'ok')::boolean AND j->>'cover_fee_status' = 'awaiting_topup' FROM v WHERE k = 'f6a'), (SELECT j::text FROM v WHERE k = 'f6a'));
SELECT pg_temp.check('F6: the next tick does nothing while the float is still short',
  (direct_pay_tick()->>'cover_fees_charged')::int = 0);
SELECT create_ledger_transaction(jsonb_build_array(
  jsonb_build_object('user_id', :brian, 'amount', 20000, 'direction', 'cash_in', 'category', 'partner_funding',
    'ledger_scope', 'wallet', 'wallet_bucket', 'float', 'recipient_type', 'operational_wallet', 'source_table', 'test', 'description', 'top-up'),
  jsonb_build_object('amount', 20000, 'direction', 'cash_out', 'category', 'wallet_deposit', 'ledger_scope', 'platform',
    'source_table', 'test', 'description', 'top-up')), 'p7-test-topup');
-- (each tick and each check are separate statements: one statement sees one snapshot)
INSERT INTO v VALUES ('f6t1', direct_pay_tick());
SELECT pg_temp.check('F6: after the top-up the tick charges the fee',
  (SELECT (j->>'cover_fees_charged')::int = 1 FROM v WHERE k = 'f6t1'), (SELECT j::text FROM v WHERE k = 'f6t1'));
SELECT pg_temp.check('F6: ...the fee shows as charged, posted once (2 legs)',
  (SELECT cover_fee_status = 'charged' FROM funder_offplatform_rent_payments WHERE id = pg_temp.pid('f6'))
  AND (SELECT count(*) FROM general_ledger WHERE idempotency_key = 'opcover-' || pg_temp.pid('f6')::text) = 2,
  (SELECT cover_fee_status FROM funder_offplatform_rent_payments WHERE id = pg_temp.pid('f6')));
SELECT pg_temp.check('F6: ...and the next tick charges nothing more', (direct_pay_tick()->>'cover_fees_charged')::int = 0);

-- ============================================================ F7: health and alerts
SELECT pg_temp.as_user(:grace);
DO $$
BEGIN
  PERFORM direct_pay_health();
  INSERT INTO t_results (name, ok, detail) VALUES ('F7: partners cannot read the health check', false, 'it answered');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO t_results (name, ok, detail) VALUES ('F7: partners cannot read the health check', SQLERRM = 'Not authorized', SQLERRM);
END $$;
SAVEPOINT f7;
SELECT pg_temp.as_user(:lucy);
INSERT INTO v VALUES ('h0', direct_pay_health());
SELECT pg_temp.check('F7: healthy now: no breaches, no approval without OTP or call note, no unbalanced group',
  (SELECT jsonb_array_length(j->'breaches') = 0 AND (j->'metrics'->>'approvals_missing_otp_or_note')::int = 0
          AND (j->'metrics'->>'unbalanced_groups')::int = 0 FROM v WHERE k = 'h0'), (SELECT j::text FROM v WHERE k = 'h0'));
UPDATE funder_offplatform_rent_payments SET created_at = now() - interval '30 hours' WHERE id = pg_temp.pid('f3');
SELECT pg_temp.check('F7: a payment waiting 30 hours is a breach',
  direct_pay_health()->'breaches' ? 'payments_waiting_over_24h');
SELECT direct_pay_health_alert();
SELECT pg_temp.check('F7: the daily alert writes it down',
  EXISTS (SELECT 1 FROM audit_logs WHERE action_type = 'direct_pay_health_breach' AND record_id = 'payments_waiting_over_24h'));
ROLLBACK TO SAVEPOINT f7;

SELECT 'FAIL' AS r, name, detail FROM t_results WHERE NOT ok ORDER BY n;
SELECT 'passed ' || count(*) FILTER (WHERE ok) || ' / ' || count(*) AS summary FROM t_results;
ROLLBACK;
