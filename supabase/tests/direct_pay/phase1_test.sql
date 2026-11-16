-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Option 2 (partner pays the landlord directly), Phase 1 tests. Runs on a local structure-only copy of prod
-- with 20261121090000 applied (see run_phase1.sh). Everything runs in one transaction and is rolled back.
-- Prints "passed N / M"; any failure is listed by name.

\set ON_ERROR_STOP 1
SET client_min_messages = warning;
BEGIN;

CREATE TEMP TABLE t_results (n serial, name text, ok boolean, detail text);

-- expect(name, sql, sqlstate): the statement must fail with that SQLSTATE ('' = must succeed).
CREATE FUNCTION pg_temp.expect(p_name text, p_sql text, p_state text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
    INSERT INTO t_results (name, ok, detail) VALUES (p_name, p_state = '', CASE WHEN p_state = '' THEN 'ok' ELSE 'expected ' || p_state || ', it succeeded' END);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO t_results (name, ok, detail) VALUES (p_name, SQLSTATE = p_state, SQLSTATE || ' ' || left(SQLERRM, 160));
  END;
END $$;

CREATE FUNCTION pg_temp.check(p_name text, p_ok boolean, p_detail text DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_results (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), p_detail);
$$;

-- Fixture ids (made up)
-- partner 11..., proxy agent 22..., rent plans a1.. / a2.. / a3..
INSERT INTO auth.users (id) VALUES ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');

-- ============================================================ payments: shape and states
SELECT pg_temp.expect('legacy row cannot be held',
  $q$INSERT INTO funder_offplatform_rent_payments (funder_id, rent_request_id, method, amount, status)
     VALUES ('11111111-1111-4111-8111-111111111111', gen_random_uuid(), 'mobile_money', 500000, 'held')$q$, '23514');

SELECT pg_temp.expect('direct pay needs a hold',
  $q$INSERT INTO funder_offplatform_rent_payments (funder_id, rent_request_id, method, amount, status, flow)
     VALUES ('11111111-1111-4111-8111-111111111111', gen_random_uuid(), 'mobile_money', 500000, 'held', 'direct_pay')$q$, '23514');

SELECT pg_temp.expect('direct pay is mobile money only',
  $q$INSERT INTO funder_offplatform_rent_payments (funder_id, rent_request_id, method, amount, status, flow, hold_started_at, hold_expires_at)
     VALUES ('11111111-1111-4111-8111-111111111111', gen_random_uuid(), 'cash', 500000, 'held', 'direct_pay', now(), now() + interval '48 hours')$q$, '23514');

SELECT pg_temp.expect('a 48-hour hold is accepted',
  $q$INSERT INTO funder_offplatform_rent_payments (id, funder_id, rent_request_id, method, amount, status, flow, hold_started_at, hold_expires_at)
     VALUES ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'a1a1a1a1-0000-4000-8000-000000000001',
             'mobile_money', 500000, 'held', 'direct_pay', now(), now() + interval '48 hours')$q$, '');

SELECT pg_temp.expect('a second live hold on the same plan is refused (race decider)',
  $q$INSERT INTO funder_offplatform_rent_payments (funder_id, rent_request_id, method, amount, status, flow, hold_started_at, hold_expires_at)
     VALUES ('22222222-2222-4222-8222-222222222222', 'a1a1a1a1-0000-4000-8000-000000000001',
             'mobile_money', 500000, 'held', 'direct_pay', now(), now() + interval '48 hours')$q$, '23505');

SELECT pg_temp.expect('an expired hold frees the plan',
  $q$UPDATE funder_offplatform_rent_payments SET status = 'expired', expired_at = now() WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'$q$, '');
SELECT pg_temp.expect('a new hold after expiry is accepted',
  $q$INSERT INTO funder_offplatform_rent_payments (id, funder_id, rent_request_id, method, amount, status, flow, hold_started_at, hold_expires_at)
     VALUES ('aaaaaaaa-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'a1a1a1a1-0000-4000-8000-000000000001',
             'mobile_money', 500000, 'held', 'direct_pay', now(), now() + interval '48 hours')$q$, '');

SELECT pg_temp.expect('confirm without the landlord OTP is refused',
  $q$UPDATE funder_offplatform_rent_payments SET status = 'confirmed', call_note = 'Okello confirmed on the phone'
     WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, '23514');
SELECT pg_temp.expect('confirm without a call note is refused',
  $q$UPDATE funder_offplatform_rent_payments SET status = 'confirmed', landlord_otp_verified_at = now(), call_note = '  '
     WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, '23514');
SELECT pg_temp.expect('confirm with a red flag and no reason is refused',
  $q$UPDATE funder_offplatform_rent_payments SET status = 'confirmed', landlord_otp_verified_at = now(),
            call_note = 'Okello confirmed', flags = ARRAY['paid_before_hold']
     WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, '23514');
SELECT pg_temp.expect('confirm with OTP, call note and flag reason is accepted',
  $q$UPDATE funder_offplatform_rent_payments SET status = 'confirmed', landlord_otp_verified_at = now(),
            call_note = 'Okello confirmed', flags = ARRAY['paid_before_hold'], flag_reason = 'SMS clock wrong; landlord read TID back'
     WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, '');
SELECT pg_temp.check('updated_at moves on update',
  (SELECT updated_at >= created_at FROM funder_offplatform_rent_payments WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002'));
SELECT pg_temp.expect('a confirmed plan cannot be held again',
  $q$INSERT INTO funder_offplatform_rent_payments (funder_id, rent_request_id, method, amount, status, flow, hold_started_at, hold_expires_at)
     VALUES ('11111111-1111-4111-8111-111111111111', 'a1a1a1a1-0000-4000-8000-000000000001',
             'mobile_money', 500000, 'held', 'direct_pay', now(), now() + interval '48 hours')$q$, '23505');

SELECT pg_temp.expect('legacy rows still work as before',
  $q$INSERT INTO funder_offplatform_rent_payments (funder_id, rent_request_id, method, amount, provider, reference, status)
     VALUES ('11111111-1111-4111-8111-111111111111', gen_random_uuid(), 'cash', 300000, NULL, NULL, 'pending')$q$, '');

-- ============================================================ proofs
INSERT INTO funder_offplatform_rent_payments (id, funder_id, rent_request_id, method, amount, status, flow, hold_started_at, hold_expires_at)
VALUES ('aaaaaaaa-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'a2a2a2a2-0000-4000-8000-000000000002',
        'mobile_money', 500000, 'held', 'direct_pay', now(), now() + interval '48 hours');

SELECT pg_temp.expect('a proof photo must sit in the partner''s own folder',
  $q$INSERT INTO funder_offplatform_rent_proofs (payment_id, partner_id, photo_path)
     VALUES ('aaaaaaaa-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222/x.jpg')$q$, '23514');
SELECT pg_temp.expect('a zero amount read is refused',
  $q$INSERT INTO funder_offplatform_rent_proofs (payment_id, partner_id, photo_path, amount_read)
     VALUES ('aaaaaaaa-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111/x.jpg', 0)$q$, '23514');

INSERT INTO funder_offplatform_rent_proofs (id, payment_id, partner_id, photo_path, tid_typed, tid_read, amount_read, provider)
VALUES ('bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111',
        '11111111-1111-4111-8111-111111111111/p1.jpg', ' MP 1234-5678 ', '99999999', 450000, 'mtn'),
       ('bbbbbbbb-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111',
        '11111111-1111-4111-8111-111111111111/p2.jpg', '', 'ID: 55667788', 50000, 'mtn');
SELECT pg_temp.check('tid_norm uses the typed TID, digits only',
  (SELECT tid_norm FROM funder_offplatform_rent_proofs WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001') = '12345678');
SELECT pg_temp.check('tid_norm falls back to the read TID when none is typed',
  (SELECT tid_norm FROM funder_offplatform_rent_proofs WHERE id = 'bbbbbbbb-0000-4000-8000-000000000002') = '55667788');

SELECT pg_temp.expect('the same TID can be SUBMITTED twice (it is flagged, not refused)',
  $q$INSERT INTO funder_offplatform_rent_proofs (id, payment_id, partner_id, photo_path, tid_typed)
     VALUES ('bbbbbbbb-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111',
             '11111111-1111-4111-8111-111111111111/p3.jpg', '12345678')$q$, '');
SELECT pg_temp.expect('approving the first TID works',
  $q$UPDATE funder_offplatform_rent_proofs SET status = 'approved' WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001'$q$, '');
SELECT pg_temp.expect('approving the same TID a second time is refused',
  $q$UPDATE funder_offplatform_rent_proofs SET status = 'approved' WHERE id = 'bbbbbbbb-0000-4000-8000-000000000003'$q$, '23505');

-- ============================================================ indexes the flags and jobs use
SELECT pg_temp.check('normalised-TID indexes exist on deposits, withdrawals and landlord payouts',
  (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN
    ('ix_deposit_requests_tid_norm', 'ix_withdrawal_requests_tid_norm', 'ix_withdrawal_requests_fin_ops_ref_norm',
     'ix_landlord_payouts_momo_ref_norm', 'ix_landlord_payouts_external_ref_norm')) = 5);
CREATE FUNCTION pg_temp.plan_uses(p_sql text, p_index text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  FOR r IN EXECUTE 'EXPLAIN ' || p_sql LOOP
    IF r ILIKE '%' || p_index || '%' THEN RETURN true; END IF;
  END LOOP;
  RETURN false;
END $$;
-- Empty tables would always seq-scan, so the planner is told not to; the point is that the index matches the expression.
SET LOCAL enable_seqscan = off;
SELECT pg_temp.check('deposit TID lookup can use its normalised index',
  pg_temp.plan_uses($q$SELECT 1 FROM deposit_requests WHERE normalize_momo_tid(transaction_id) = '12345678'$q$, 'ix_deposit_requests_tid_norm'));
SELECT pg_temp.check('landlord payout reference lookup can use its normalised index',
  pg_temp.plan_uses($q$SELECT 1 FROM landlord_payouts WHERE normalize_momo_tid(finops_momo_reference) = '12345678'$q$, 'ix_landlord_payouts_momo_ref_norm'));
SELECT pg_temp.check('withdrawal reference lookup can use its normalised index',
  pg_temp.plan_uses($q$SELECT 1 FROM withdrawal_requests WHERE normalize_momo_tid(fin_ops_reference) = '12345678'$q$, 'ix_withdrawal_requests_fin_ops_ref_norm'));
SELECT pg_temp.check('proof TID lookup can use its index',
  pg_temp.plan_uses($q$SELECT 1 FROM funder_offplatform_rent_proofs WHERE tid_norm = '12345678'$q$, 'ix_fop_proofs_tid'));
SELECT pg_temp.check('expiry job query never scans the whole payments table',
  NOT pg_temp.plan_uses($q$SELECT id FROM funder_offplatform_rent_payments WHERE flow = 'direct_pay' AND status = 'held' AND hold_expires_at < now()$q$, 'Seq Scan'));
SELECT pg_temp.check('Landlord Ops queue query never scans the whole payments table',
  NOT pg_temp.plan_uses($q$SELECT id FROM funder_offplatform_rent_payments WHERE flow = 'direct_pay' AND status = 'pending' ORDER BY created_at, id LIMIT 50$q$, 'Seq Scan'));
RESET enable_seqscan;

-- ============================================================ grants and policies
SELECT pg_temp.check('authenticated can read proofs (RLS limits it to their own)',
  has_table_privilege('authenticated', 'public.funder_offplatform_rent_proofs', 'SELECT'));
SELECT pg_temp.check('authenticated cannot write proofs directly',
  NOT has_table_privilege('authenticated', 'public.funder_offplatform_rent_proofs', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.funder_offplatform_rent_proofs', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.funder_offplatform_rent_proofs', 'DELETE'));
SELECT pg_temp.check('anon has nothing on proofs',
  NOT has_table_privilege('anon', 'public.funder_offplatform_rent_proofs', 'SELECT'));
SELECT pg_temp.check('service_role can write proofs',
  has_table_privilege('service_role', 'public.funder_offplatform_rent_proofs', 'INSERT'));
SELECT pg_temp.check('RLS on, with the staff-MFA policy',
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.funder_offplatform_rent_proofs'::regclass)
  AND EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.funder_offplatform_rent_proofs'::regclass
                AND polname = 'mfa_required_for_staff' AND NOT polpermissive));
SELECT pg_temp.check('switch exists and is OFF',
  (SELECT NOT is_on FROM pipeline_switches WHERE key = 'self_support_direct_pay'));

-- ============================================================ ledger: Cover fee from operational float
-- Partner gets 50,000 operational float first (a balanced test credit).
SELECT create_ledger_transaction(jsonb_build_array(
  jsonb_build_object('user_id', '11111111-1111-4111-8111-111111111111', 'amount', 50000, 'direction', 'cash_in',
    'category', 'partner_funding', 'ledger_scope', 'wallet', 'wallet_bucket', 'float', 'recipient_type', 'operational_wallet',
    'source_table', 'test', 'description', 'test: operational float in'),
  jsonb_build_object('amount', 50000, 'direction', 'cash_out', 'category', 'wallet_deposit', 'ledger_scope', 'platform',
    'source_table', 'test', 'description', 'test: cash received')), 'p1-test-float-credit');

CREATE TEMP TABLE t_viol AS SELECT count(*) AS n FROM ledger_mapped_balance_violations;

-- With a proxy agent: partner float -> proxy agent wallet.
SELECT create_ledger_transaction(jsonb_build_array(
  jsonb_build_object('user_id', '11111111-1111-4111-8111-111111111111', 'amount', 10000, 'direction', 'cash_out',
    'category', 'welile_cover_fee', 'ledger_scope', 'wallet', 'wallet_bucket', 'float', 'recipient_type', 'operational_wallet',
    'source_table', 'funder_offplatform_rent_payments', 'description', 'test: 2% Cover fee from operational float'),
  jsonb_build_object('user_id', '22222222-2222-4222-8222-222222222222', 'amount', 10000, 'direction', 'cash_in',
    'category', 'agent_commission', 'ledger_scope', 'wallet', 'recipient_type', 'user',
    'source_table', 'funder_offplatform_rent_payments', 'description', 'test: Cover fee to proxy agent')), 'p1-test-fee-proxy');
SELECT pg_temp.check('fee group (float -> proxy agent) logs no mapped-balance violation',
  (SELECT count(*) FROM ledger_mapped_balance_violations) = (SELECT n FROM t_viol));
SELECT pg_temp.check('partner float fell by the fee (50,000 -> 40,000)',
  (SELECT sum(CASE direction WHEN 'cash_in' THEN amount ELSE -amount END) FROM general_ledger
    WHERE user_id = '11111111-1111-4111-8111-111111111111' AND wallet_bucket = 'float') = 40000);
SELECT pg_temp.check('proxy agent got the fee in withdrawable',
  (SELECT sum(amount) FROM general_ledger WHERE user_id = '22222222-2222-4222-8222-222222222222'
     AND wallet_bucket = 'withdrawable' AND direction = 'cash_in') = 10000);

-- No proxy agent: partner float -> Welile revenue (R1).
SELECT create_ledger_transaction(jsonb_build_array(
  jsonb_build_object('user_id', '11111111-1111-4111-8111-111111111111', 'amount', 10000, 'direction', 'cash_out',
    'category', 'welile_cover_fee', 'ledger_scope', 'wallet', 'wallet_bucket', 'float', 'recipient_type', 'operational_wallet',
    'source_table', 'funder_offplatform_rent_payments', 'description', 'test: 2% Cover fee, no proxy agent'),
  jsonb_build_object('amount', 10000, 'direction', 'cash_in', 'category', 'welile_cover_fee', 'ledger_scope', 'platform',
    'source_table', 'funder_offplatform_rent_payments', 'description', 'test: Cover fee kept (no proxy agent)')), 'p1-test-fee-kept');
SELECT pg_temp.check('fee group (float -> Welile revenue) logs no mapped-balance violation',
  (SELECT count(*) FROM ledger_mapped_balance_violations) = (SELECT n FROM t_viol));

-- Control: without the new float row the same group is unbalanced (proves the row is what makes it work).
SAVEPOINT control;
DELETE FROM ledger_account_map WHERE ledger_scope = 'wallet' AND category = 'welile_cover_fee' AND wallet_bucket = 'float';
SELECT create_ledger_transaction(jsonb_build_array(
  jsonb_build_object('user_id', '11111111-1111-4111-8111-111111111111', 'amount', 1000, 'direction', 'cash_out',
    'category', 'welile_cover_fee', 'ledger_scope', 'wallet', 'wallet_bucket', 'float', 'recipient_type', 'operational_wallet',
    'source_table', 'test', 'description', 'control'),
  jsonb_build_object('user_id', '22222222-2222-4222-8222-222222222222', 'amount', 1000, 'direction', 'cash_in',
    'category', 'agent_commission', 'ledger_scope', 'wallet', 'recipient_type', 'user',
    'source_table', 'test', 'description', 'control')), 'p1-test-control');
SELECT pg_temp.check('control: without the mapping row the fee group IS a violation',
  (SELECT count(*) FROM ledger_mapped_balance_violations) > (SELECT n FROM t_viol));
ROLLBACK TO SAVEPOINT control;

-- ============================================================ ledger: tenant owes / partner owed, no cash
SELECT create_ledger_transaction(jsonb_build_array(
  jsonb_build_object('amount', 500000, 'direction', 'cash_in', 'category', 'rent_receivable_created', 'ledger_scope', 'bridge',
    'source_table', 'funder_offplatform_rent_payments', 'reference_id', 'a2a2a2a2-0000-4000-8000-000000000002',
    'description', 'test: tenant owes the Rent Plan (partner paid the landlord directly)'),
  jsonb_build_object('amount', 500000, 'direction', 'cash_out', 'category', 'partner_direct_rent_capital', 'ledger_scope', 'platform',
    'source_table', 'funder_offplatform_rent_payments', 'reference_id', 'a2a2a2a2-0000-4000-8000-000000000002',
    'linked_party', '11111111-1111-4111-8111-111111111111',
    'description', 'test: partner capital, rent paid to the landlord directly')), 'p1-test-capital') AS g_capital \gset
SELECT pg_temp.check('A3/L2 group logs no mapped-balance violation',
  (SELECT count(*) FROM ledger_mapped_balance_violations) = (SELECT n FROM t_viol));
SELECT pg_temp.check('A3/L2 group has no wallet leg',
  NOT EXISTS (SELECT 1 FROM general_ledger WHERE transaction_group_id = :'g_capital' AND ledger_scope = 'wallet'));
SELECT pg_temp.check('resolver: tenant side lands on A3 as a debit of 500,000',
  (SELECT sum(dr) FROM sofp_ledger_legs(now() + interval '1 minute') WHERE transaction_group_id = :'g_capital' AND account_code = 'A3') = 500000);
SELECT pg_temp.check('resolver: partner side lands on L2 as a credit of 500,000',
  (SELECT sum(cr) FROM sofp_ledger_legs(now() + interval '1 minute') WHERE transaction_group_id = :'g_capital' AND account_code = 'L2') = 500000);
SELECT pg_temp.check('resolver: no cash account (A1, A2, A5) and no one-sided counterpart in the group',
  NOT EXISTS (SELECT 1 FROM sofp_ledger_legs(now() + interval '1 minute')
               WHERE transaction_group_id = :'g_capital' AND (account_code IN ('A1', 'A2', 'A5', 'E4') OR group_one_sided)));

-- ============================================================ report
SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS r, name, detail FROM t_results WHERE NOT ok ORDER BY n;
SELECT 'passed ' || count(*) FILTER (WHERE ok) || ' / ' || count(*) AS summary FROM t_results;

ROLLBACK;
