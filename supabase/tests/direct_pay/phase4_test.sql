-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Option 2 phase 4 tests: every message (wording, audience, once only), the agent's receipt email, reminders,
-- hold expiry and the 24-hour COO marker. Needs phases 1-4 and phase2_fixture.sql. One transaction, rolled back.

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
-- The SMS a recipient got for one payment and event.
CREATE FUNCTION pg_temp.sms(p_payment uuid, p_event text, p_audience text) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(message, ' || ') FROM self_support_notices
   WHERE ref_type = 'direct_payment' AND ref_id = p_payment AND event = p_event AND audience = p_audience AND channel = 'sms'
$$;

\set grace '''11111111-1111-4111-8111-111111111111'''
\set brian '''33333333-3333-4333-8333-333333333333'''
\set lucy  '''66666666-6666-4666-8666-666666666666'''
\set sam   '''88888888-8888-4888-8888-888888888888'''

SET LOCAL session_replication_role = replica;
INSERT INTO auth.users (id, email) VALUES (:lucy, 'lucy@example.test'), (:sam, 'sam@example.test');
UPDATE auth.users SET email = 'grace@example.test' WHERE id = :grace;
UPDATE auth.users SET email = 'peter@example.test' WHERE id = '55555555-5555-4555-8555-555555555555';
INSERT INTO profiles (id, full_name, email, phone) VALUES (:lucy, 'Lucy Landlord Ops', 'lucy@example.test', '0700000006'),
                                                          (:sam, 'Sam Proxy', 'sam@example.test', '0700000008');
INSERT INTO user_roles (user_id, role, enabled) VALUES (:lucy, 'landlord_ops', true), (:sam, 'agent', true);
INSERT INTO commission_fund_ins (fund_in_key, partner_id, source_table, source_id, amount, occurred_at, status, earner_id, earner_path)
VALUES ('test:brian-first', :brian, 'test', gen_random_uuid(), 100000, now() - interval '30 days', 'paid', :sam, 'promissory_note');
UPDATE rent_requests SET tenant_ops_reviewed_at = now() - interval '2 days', tenant_ops_reviewed_by = :lucy WHERE id = pg_temp.plan(3);
INSERT INTO vault.decrypted_secrets (name, decrypted_secret) VALUES ('email_queue_service_role_key', 'test-service-key') ON CONFLICT DO NOTHING;
SET LOCAL session_replication_role = origin;
SELECT create_ledger_transaction(jsonb_build_array(
  jsonb_build_object('user_id', :brian, 'amount', 20000, 'direction', 'cash_in', 'category', 'partner_funding',
    'ledger_scope', 'wallet', 'wallet_bucket', 'float', 'recipient_type', 'operational_wallet', 'source_table', 'test', 'description', 'test float'),
  jsonb_build_object('amount', 20000, 'direction', 'cash_out', 'category', 'wallet_deposit', 'ledger_scope', 'platform',
    'source_table', 'test', 'description', 'test cash')), 'p4-test-float-brian');

-- ============================================================ hold started
SELECT pg_temp.as_user(:grace);
INSERT INTO v VALUES ('g1', direct_pay_claim(pg_temp.plan(1)));
SELECT pg_temp.check('hold started: SMS to the partner with tenant, amount, landlord and verified number',
  pg_temp.sms(pg_temp.pid('g1'), 'dp_hold_started', 'partner') LIKE 'WELILE: Musa''s Rent Plan is held for you until %. Send UGX 500,000 to landlord Okello on +256 772 123456, then upload the SMS in the app.',
  pg_temp.sms(pg_temp.pid('g1'), 'dp_hold_started', 'partner'));
SELECT pg_temp.check('hold started: also by email to the partner',
  EXISTS (SELECT 1 FROM self_support_notices WHERE ref_id = pg_temp.pid('g1') AND event = 'dp_hold_started' AND channel = 'email'
            AND to_address = 'grace@example.test' AND subject = 'Rent Plan held for you: pay the landlord directly'));
SELECT direct_pay_claim(pg_temp.plan(1));
SELECT pg_temp.check('claiming again sends nothing new',
  (SELECT count(*) FROM self_support_notices WHERE ref_id = pg_temp.pid('g1') AND event = 'dp_hold_started') = 2);

-- ============================================================ proof received
SELECT direct_pay_record_proof(:grace, pg_temp.pid('g1'), :grace || '/r1.jpg', 'sha-r1', 'mtn', NULL, NULL,
  jsonb_build_object('status', 'read', 'tid', '1111', 'amount', 450000, 'phone', '0772123456', 'paid_at', (now() + interval '1 minute')::text));
SELECT pg_temp.check('a short proof sends no "received" message yet',
  pg_temp.sms(pg_temp.pid('g1'), 'dp_proof_received', 'partner') IS NULL);
SELECT direct_pay_record_proof(:grace, pg_temp.pid('g1'), :grace || '/r1b.jpg', 'sha-r1b', 'mtn', '2222', 50000, '{"status":"error"}'::jsonb);
SELECT pg_temp.check('proof complete: "We got your proof" to the partner',
  pg_temp.sms(pg_temp.pid('g1'), 'dp_proof_received', 'partner')
    = 'WELILE: We got your proof for Musa''s Rent Plan. Our team will call Okello to confirm. We''ll tell you when it''s done.');

-- ============================================================ reminders
INSERT INTO v VALUES ('g5', direct_pay_claim(pg_temp.plan(5)));
SELECT pg_temp.check('a hold younger than 2 hours gets no reminder',
  (direct_pay_send_reminders()->>'reminders')::int = 0);
UPDATE funder_offplatform_rent_payments SET hold_started_at = now() - interval '3 hours', hold_expires_at = now() + interval '45 hours'
 WHERE id = pg_temp.pid('g5');
SELECT pg_temp.check('reminder 1 goes out', (direct_pay_send_reminders()->>'reminders')::int = 1);
SELECT pg_temp.check('reminder 1 wording: held until, amount, landlord and number',
  pg_temp.sms(pg_temp.pid('g5'), 'dp_reminder_1', 'partner') LIKE 'WELILE: Reminder: Tenant''s Rent Plan is held for you until % Send UGX 500,000 to Okello on +256 772 123456 and upload the SMS.'
  OR pg_temp.sms(pg_temp.pid('g5'), 'dp_reminder_1', 'partner') LIKE 'WELILE: Reminder: %Rent Plan is held for you until %. Send UGX 500,000 to Okello on +256 772 123456 and upload the SMS.',
  pg_temp.sms(pg_temp.pid('g5'), 'dp_reminder_1', 'partner'));
SELECT pg_temp.check('the same slot run twice sends nothing more', (direct_pay_send_reminders()->>'reminders')::int = 0);
UPDATE funder_offplatform_rent_payments SET last_reminder_at = now() - interval '12 hours', hold_expires_at = now() + interval '10 hours'
 WHERE id = pg_temp.pid('g5');
SELECT direct_pay_send_reminders();
SELECT pg_temp.check('the reminder before the hold ends is the "Last reminder"',
  pg_temp.sms(pg_temp.pid('g5'), 'dp_reminder_2', 'partner') LIKE 'WELILE: Last reminder: upload your SMS for %''s Rent Plan before %, or the plan opens to other partners.',
  pg_temp.sms(pg_temp.pid('g5'), 'dp_reminder_2', 'partner'));
UPDATE funder_offplatform_rent_payments SET last_reminder_at = now() - interval '12 hours', reminders_sent = 4 WHERE id = pg_temp.pid('g5');
SELECT pg_temp.check('never more than 4 reminders', (direct_pay_send_reminders()->>'reminders')::int = 0);
SELECT pg_temp.check('a complete proof (pending) gets no reminders',
  NOT EXISTS (SELECT 1 FROM self_support_notices WHERE ref_id = pg_temp.pid('g1') AND event LIKE 'dp_reminder_%'));

-- ============================================================ hold ended, released
UPDATE funder_offplatform_rent_payments SET hold_expires_at = now() - interval '1 minute' WHERE id = pg_temp.pid('g5');
SELECT pg_temp.check('the tick ends the hold', (direct_pay_tick()->>'expired')::int = 1);
SELECT pg_temp.check('hold ended: SMS with the support number',
  pg_temp.sms(pg_temp.pid('g5'), 'dp_hold_ended', 'partner') LIKE 'WELILE: The hold on %''s Rent Plan has ended and it is open to other partners. If you already paid, call +256 748 747134 today.');
INSERT INTO v VALUES ('g6', direct_pay_claim(pg_temp.plan(6)));
SELECT direct_pay_release(pg_temp.pid('g6'));
SELECT pg_temp.check('a partner who lets go early gets no "hold ended" message',
  pg_temp.sms(pg_temp.pid('g6'), 'dp_hold_ended', 'partner') IS NULL);

-- ============================================================ approved (Brian, proxy agent Sam)
SELECT pg_temp.as_user(:brian);
INSERT INTO v VALUES ('b3', direct_pay_claim(pg_temp.plan(3)));
SELECT direct_pay_record_proof(:brian, pg_temp.pid('b3'), :brian || '/r3.jpg', 'sha-r3', 'mtn', NULL, NULL,
  jsonb_build_object('status', 'read', 'tid', '3030', 'amount', 500000, 'phone', '+256772123456', 'paid_at', (now() + interval '1 minute')::text));
SELECT pg_temp.as_user(:lucy);
INSERT INTO v VALUES ('otp', direct_pay_otp_issue(:lucy, pg_temp.pid('b3')));
INSERT INTO v VALUES ('a', direct_pay_approve(pg_temp.pid('b3'), (SELECT j->>'otp' FROM v WHERE k = 'otp'), 'Okello confirmed', NULL));
SELECT pg_temp.check('approved', (SELECT (j->>'ok')::boolean FROM v WHERE k = 'a'), (SELECT j::text FROM v WHERE k = 'a'));
SELECT pg_temp.check('partner: landlord confirmed, portfolio active, Rent Profit Share starts today',
  pg_temp.sms(pg_temp.pid('b3'), 'dp_approved', 'partner')
    = 'WELILE: Okello confirmed UGX 500,000 for Tenant''s Rent Plan. Your portfolio is active and your Rent Profit Share starts today.',
  pg_temp.sms(pg_temp.pid('b3'), 'dp_approved', 'partner'));
SELECT pg_temp.check('agent: who paid, the WLR receipt number and link, what they earned, do NOT pay',
  pg_temp.sms(pg_temp.pid('b3'), 'dp_approved', 'agent') =
    'WELILE: Partner Brian paid landlord Okello UGX 500,000 for Tenant''s rent. Receipt ' || (SELECT j->>'receipt_number' FROM v WHERE k = 'a')
    || ': https://welileapp.com/r/' || (SELECT j->>'receipt_code' FROM v WHERE k = 'a')
    || '. You earned UGX 10,000. Upload Okello''s signed receipt in the app. Do NOT pay Okello for this Rent Plan.',
  pg_temp.sms(pg_temp.pid('b3'), 'dp_approved', 'agent'));
SELECT pg_temp.check('agent: the branded receipt email is posted once, with the receipt link',
  (SELECT count(*) = 1 AND bool_and(body->>'templateName' = 'agent-landlord-paid-receipt'
          AND body->'templateData'->>'receipt_url' = 'https://welileapp.com/r/' || (SELECT j->>'receipt_code' FROM v WHERE k = 'a')
          AND body->>'recipientEmail' = 'peter@example.test')
     FROM net.t_calls WHERE url LIKE '%/send-transactional-email' AND body->>'idempotencyKey' = 'direct-pay-ap-email:' || pg_temp.pid('b3')::text));
SELECT pg_temp.check('tenant: rent paid, Rent Plan started, agent shares the schedule',
  pg_temp.sms(pg_temp.pid('b3'), 'dp_approved', 'tenant')
    = 'WELILE: Your rent of UGX 500,000 has been paid to Okello. Your Rent Plan has started. Peter will share your repayment schedule.');
SELECT pg_temp.check('proxy agent: the Cover fee they earned',
  pg_temp.sms(pg_temp.pid('b3'), 'dp_approved', 'proxy_agent') = 'WELILE: You earned UGX 10,000 Cover fee on Brian''s Rent Plan support.');
SELECT public._direct_pay_notify(pg_temp.pid('b3'), 'dp_approved');
SELECT public._direct_pay_agent_receipt_email(pg_temp.pid('b3'));
SELECT pg_temp.check('calling approved again sends nothing twice',
  (SELECT count(*) FROM self_support_notices WHERE ref_id = pg_temp.pid('b3') AND event = 'dp_approved' AND channel = 'sms') = 4
  AND (SELECT count(*) FROM net.t_calls WHERE body->>'idempotencyKey' = 'direct-pay-ap-email:' || pg_temp.pid('b3')::text) = 1);

-- ============================================================ rejected
SELECT pg_temp.check('reject', (direct_pay_reject(pg_temp.pid('g1'), 'Okello says nothing arrived')->>'ok')::boolean);
SELECT pg_temp.check('rejected: never held, can''t refund, support number',
  pg_temp.sms(pg_temp.pid('g1'), 'dp_rejected', 'partner')
    = 'WELILE: Okello did not confirm receiving UGX 500,000 for Musa''s Rent Plan, so it was not approved. Welile never held this money and can''t refund it. Call +256 748 747134 and we''ll help you follow up with the landlord.');

-- ============================================================ 24-hour COO marker
SELECT pg_temp.as_user(:grace);
INSERT INTO v VALUES ('g7', direct_pay_claim(pg_temp.plan(7)));
SELECT direct_pay_record_proof(:grace, pg_temp.pid('g7'), :grace || '/r7.jpg', 'sha-r7', 'mtn', NULL, NULL,
  jsonb_build_object('status', 'read', 'tid', '7777', 'amount', 500000, 'phone', '0772123456', 'paid_at', (now() + interval '1 minute')::text));
UPDATE funder_offplatform_rent_payments SET created_at = now() - interval '25 hours' WHERE id = pg_temp.pid('g7');
SELECT pg_temp.check('the tick marks a payment waiting over 24 hours for the COO', (direct_pay_tick()->>'marked_for_coo')::int = 1);
SELECT pg_temp.check('...once only, with an audit row',
  (direct_pay_tick()->>'marked_for_coo')::int = 0
  AND EXISTS (SELECT 1 FROM audit_logs WHERE action_type = 'direct_pay_waiting_over_24h' AND record_id = pg_temp.pid('g7')::text));

-- ============================================================ the queue is drained by the existing sender
SELECT funder_release_sms_dispatch();
SELECT pg_temp.check('the every-minute sender is called for the waiting SMS',
  EXISTS (SELECT 1 FROM net.t_calls WHERE url LIKE '%/notify-funder-release-sms'));

-- ============================================================ words
SELECT pg_temp.check('no forbidden words in any option 2 message (loan, lender, interest, ROI, Agent Care)',
  NOT EXISTS (SELECT 1 FROM self_support_notices WHERE ref_type = 'direct_payment'
               AND message ~* '(\mloan\M|\mlender\M|\minterest\M|\mROI\M|agent care)'));

SELECT 'FAIL' AS r, name, detail FROM t_results WHERE NOT ok ORDER BY n;
SELECT 'passed ' || count(*) FILTER (WHERE ok) || ' / ' || count(*) AS summary FROM t_results;
ROLLBACK;
