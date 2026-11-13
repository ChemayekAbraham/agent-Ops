-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Option 2 phase 3 tests: Landlord Ops queue, landlord OTP, approve (portfolio, books, Cover fee, agent pay,
-- receipt, repaying, payout clock) and reject. Needs phase2_fixture.sql. One transaction, rolled back.

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
CREATE FUNCTION pg_temp.pid(p_k text) RETURNS uuid LANGUAGE sql AS $$ SELECT (j->>'payment_id')::uuid FROM v WHERE k = p_k $$;

\set grace '''11111111-1111-4111-8111-111111111111'''
\set brian '''33333333-3333-4333-8333-333333333333'''
\set peter '''55555555-5555-4555-8555-555555555555'''
\set lucy  '''66666666-6666-4666-8666-666666666666'''
\set tom   '''77777777-7777-4777-8777-777777777777'''
\set sam   '''88888888-8888-4888-8888-888888888888'''

-- ------------------------------------------------------------ setup (staff, proxy agent, tenant review)
SET LOCAL session_replication_role = replica;
INSERT INTO auth.users (id) VALUES (:lucy), (:tom), (:sam);
INSERT INTO profiles (id, full_name, email, phone) VALUES
  (:lucy, 'Lucy Landlord Ops', 'lucy@example.test', '0700000006'),
  (:tom,  'Tom COO',           'tom@example.test',  '0700000007'),
  (:sam,  'Sam Proxy',         'sam@example.test',  '0700000008');
INSERT INTO user_roles (user_id, role, enabled) VALUES (:lucy, 'landlord_ops', true), (:tom, 'coo', true), (:sam, 'agent', true);
-- Brian's proxy agent is Sam (the earner rule locks to a partner's first paid fund-in).
INSERT INTO commission_fund_ins (fund_in_key, partner_id, source_table, source_id, amount, occurred_at, status, earner_id, earner_path)
VALUES ('test:brian-first', :brian, 'test', gen_random_uuid(), 100000, now() - interval '30 days', 'paid', :sam, 'promissory_note');
UPDATE rent_requests SET tenant_ops_reviewed_at = now() - interval '2 days', tenant_ops_reviewed_by = :lucy
 WHERE id IN (pg_temp.plan(1), pg_temp.plan(3));
SET LOCAL session_replication_role = origin;
SELECT create_ledger_transaction(jsonb_build_array(
  jsonb_build_object('user_id', :brian, 'amount', 20000, 'direction', 'cash_in', 'category', 'partner_funding',
    'ledger_scope', 'wallet', 'wallet_bucket', 'float', 'recipient_type', 'operational_wallet', 'source_table', 'test', 'description', 'test float'),
  jsonb_build_object('amount', 20000, 'direction', 'cash_out', 'category', 'wallet_deposit', 'ledger_scope', 'platform',
    'source_table', 'test', 'description', 'test cash')), 'p3-test-float-brian');

-- Three payments reach Landlord Ops.
SELECT pg_temp.as_user(:grace);
INSERT INTO v VALUES ('g1', direct_pay_claim(pg_temp.plan(1)));
SELECT direct_pay_record_proof(:grace, pg_temp.pid('g1'), :grace || '/r1-a.jpg', 'sha-g1a', 'mtn', NULL, NULL,
  jsonb_build_object('status', 'read', 'tid', 'MP231117.1111', 'amount', 450000, 'phone', '0772123456', 'paid_at', (now() + interval '1 minute')::text));
SELECT direct_pay_record_proof(:grace, pg_temp.pid('g1'), :grace || '/r1-b.jpg', 'sha-g1b', 'mtn', 'MP231117.2222', 50000, '{"status":"error"}'::jsonb);
INSERT INTO v VALUES ('g4', direct_pay_claim(pg_temp.plan(4)));
SELECT direct_pay_record_proof(:grace, pg_temp.pid('g4'), :grace || '/r4.jpg', 'sha-g4', 'airtel', NULL, NULL,
  jsonb_build_object('status', 'read', 'tid', '4444', 'amount', 500000, 'phone', '0772123456', 'paid_at', (now() + interval '1 minute')::text));
SELECT pg_temp.as_user(:brian);
INSERT INTO v VALUES ('b3', direct_pay_claim(pg_temp.plan(3)));
SELECT direct_pay_record_proof(:brian, pg_temp.pid('b3'), :brian || '/r3.jpg', 'sha-b3', 'mtn', NULL, NULL,
  jsonb_build_object('status', 'read', 'tid', 'MP231117.3030', 'amount', 500000, 'phone', '+256772123456', 'paid_at', (now() + interval '1 minute')::text));
SELECT pg_temp.check('setup: three payments pending',
  (SELECT count(*) = 3 FROM funder_offplatform_rent_payments WHERE flow = 'direct_pay' AND status = 'pending'));

-- ============================================================ queue
SELECT pg_temp.as_user(:lucy);
INSERT INTO v VALUES ('q', direct_pay_ops_queue());
SELECT pg_temp.check('queue: Landlord Ops see all three, and may act',
  (SELECT jsonb_array_length(j->'rows') = 3 AND (j->>'can_act')::boolean FROM v WHERE k = 'q'));
SELECT pg_temp.check('queue: flagged payments come first',
  (SELECT (j->'rows'->0->>'has_flags')::boolean AND NOT (j->'rows'->2->>'has_flags')::boolean FROM v WHERE k = 'q'),
  (SELECT jsonb_path_query_array(j, '$.rows[*].has_flags')::text FROM v WHERE k = 'q'));
SELECT pg_temp.check('queue: every row carries proofs, landlord phone on file, partner, tenant',
  (SELECT bool_and(jsonb_array_length(r->'proofs') > 0 AND r->'landlord'->>'phone_on_file' = '0772123456'
                   AND r->'partner'->>'name' IS NOT NULL AND r->'tenant'->>'name' IS NOT NULL)
          AND bool_or(r->'tenant'->>'name' = 'Musa Tenant')
     FROM v, jsonb_array_elements(j->'rows') r WHERE k = 'q'));
SELECT pg_temp.check('queue: keyset paging returns the rest without repeats',
  (WITH p1 AS (SELECT direct_pay_ops_queue('pending', NULL, NULL, NULL, 2) j),
        last AS (SELECT j->'rows'->1 r FROM p1),
        p2 AS (SELECT direct_pay_ops_queue('pending', (r->>'has_flags')::boolean, (r->>'created_at')::timestamptz,
                                           (r->>'payment_id')::uuid, 2) j FROM last)
   SELECT jsonb_array_length((SELECT j->'rows' FROM p2)) = 1
      AND NOT ((SELECT j->'rows'->0->>'payment_id' FROM p2) IN
               (SELECT x->>'payment_id' FROM p1, jsonb_array_elements(p1.j->'rows') x))));
SELECT pg_temp.as_user(:tom);
SELECT pg_temp.check('queue: the COO sees it read-only',
  (SELECT jsonb_array_length(j->'rows') = 3 AND NOT (j->>'can_act')::boolean FROM (SELECT direct_pay_ops_queue() j) s));
SELECT pg_temp.expect_error('the COO cannot approve', format('SELECT direct_pay_approve(%L, ''123456'', ''x'', ''x'')', pg_temp.pid('b3')), 'Not authorized');
SELECT pg_temp.expect_error('the COO cannot reject', format('SELECT direct_pay_reject(%L, ''x'')', pg_temp.pid('g4')), 'Not authorized');
SELECT pg_temp.as_user(:grace);
SELECT pg_temp.expect_error('a partner cannot open the queue', 'SELECT direct_pay_ops_queue()', 'Not authorized');

-- ============================================================ OTP
SELECT pg_temp.as_user(:lucy);
SELECT pg_temp.check('approve before any code: otp_required',
  direct_pay_approve(pg_temp.pid('b3'), '000000', 'Okello confirmed', NULL)->>'code' = 'otp_required');
SELECT pg_temp.check('authorize (officer token) passes for Landlord Ops',
  (direct_pay_otp_authorize(pg_temp.pid('b3'))->>'ok')::boolean);
INSERT INTO v VALUES ('otp_b3', direct_pay_otp_issue(:lucy, pg_temp.pid('b3')));
SELECT direct_pay_otp_mark((SELECT (j->>'challenge_id')::uuid FROM v WHERE k = 'otp_b3'), true, NULL);
SELECT pg_temp.check('issue: a 6-digit code to the phone on file',
  (SELECT j->>'otp' ~ '^\d{6}$' AND j->>'recipient_phone' = '0772123456' FROM v WHERE k = 'otp_b3'));
SELECT pg_temp.check('issue: only the hash is stored',
  (SELECT otp_hash <> (SELECT j->>'otp' FROM v WHERE k = 'otp_b3') AND length(otp_hash) = 64
     FROM direct_pay_landlord_otps WHERE id = (SELECT (j->>'challenge_id')::uuid FROM v WHERE k = 'otp_b3')));
SELECT pg_temp.check('issue refuses a non-Landlord-Ops caller',
  direct_pay_otp_issue(:tom, pg_temp.pid('b3'))->>'code' = 'not_authorized');
SELECT pg_temp.check('wrong code: refused, 2 tries left',
  (SELECT j->>'code' = 'otp_wrong' AND (j->>'attempts_left')::int = 2
     FROM (SELECT direct_pay_approve(pg_temp.pid('b3'), '999999', 'Brian''s landlord confirmed', NULL) j) s));
SELECT pg_temp.check('...and the wrong try is saved, not rolled back',
  (SELECT attempts = 1 FROM direct_pay_landlord_otps WHERE id = (SELECT (j->>'challenge_id')::uuid FROM v WHERE k = 'otp_b3')));
SELECT pg_temp.check('no call note: call_note_required',
  direct_pay_approve(pg_temp.pid('b3'), (SELECT j->>'otp' FROM v WHERE k = 'otp_b3'), '  ', NULL)->>'code' = 'call_note_required');

-- ============================================================ approve: Brian, R3, proxy agent Sam
INSERT INTO v VALUES ('a_b3', direct_pay_approve(pg_temp.pid('b3'), (SELECT j->>'otp' FROM v WHERE k = 'otp_b3'),
                                                'Called Okello on 0772123456; confirmed UGX 500,000 from Brian', NULL));
SELECT pg_temp.check('approve: ok, with a WLR receipt and code', (SELECT (j->>'ok')::boolean AND j->>'receipt_number' LIKE 'WLR-%'
  AND length(j->>'receipt_code') >= 8 FROM v WHERE k = 'a_b3'), (SELECT j::text FROM v WHERE k = 'a_b3'));
SELECT pg_temp.check('payment confirmed with the OTP time and call note',
  (SELECT status = 'confirmed' AND landlord_otp_verified_at IS NOT NULL AND call_note LIKE 'Called Okello%' AND confirmed_by = :lucy
     FROM funder_offplatform_rent_payments WHERE id = pg_temp.pid('b3')));
SELECT pg_temp.check('portfolio: active, 500,000, Rent Profit Share in 30 days',
  (SELECT status = 'active' AND investment_amount = 500000 AND next_roi_date = (now() AT TIME ZONE 'Africa/Kampala')::date + 30
     FROM investor_portfolios WHERE id = (SELECT (j->>'portfolio_id')::uuid FROM v WHERE k = 'a_b3')));
SELECT pg_temp.check('commitment and funding line active (principal 500,000, no proxy fee in capital)',
  (SELECT c.status = 'active' AND c.committed_amount = 500000 AND c.next_payout_at IS NOT NULL
          AND l.status = 'active' AND l.principal = 500000 AND l.proxy_fee = 0
     FROM partner_self_commitments c JOIN partner_self_funding_lines l ON l.commitment_id = c.id
    WHERE c.id = (SELECT (j->>'commitment_id')::uuid FROM v WHERE k = 'a_b3')));
SELECT pg_temp.check('pending-portfolio link approved (self_managed)',
  (SELECT status = 'approved' AND source = 'self_managed' FROM funder_pending_portfolios
    WHERE portfolio_id = (SELECT (j->>'portfolio_id')::uuid FROM v WHERE k = 'a_b3')));
SELECT pg_temp.check('Rent Plan: repaying from tomorrow, funded, linked to Brian',
  (SELECT status = 'repaying' AND repayment_starts_on = (now() AT TIME ZONE 'Africa/Kampala')::date + 1
          AND funded_at IS NOT NULL AND self_funding_partner_id = :brian FROM rent_requests WHERE id = pg_temp.plan(3)));
SELECT pg_temp.check('billing starts tomorrow (rent_plan_billable_from)',
  rent_plan_billable_from(pg_temp.plan(3)) = (now() AT TIME ZONE 'Africa/Kampala')::date + 1);
SELECT pg_temp.check('Tenant Ops clock: counting, starts tomorrow (not "landlord not paid")',
  (SELECT c.* ::text LIKE '%counting%' FROM _am_plan_clock_core(ARRAY[pg_temp.plan(3)]) c),
  (SELECT c.*::text FROM _am_plan_clock_core(ARRAY[pg_temp.plan(3)]) c));
SELECT pg_temp.check('books: A3 debit 500,000 and L2 credit 500,000, nothing else, through the resolver',
  (SELECT sum(dr) FILTER (WHERE account_code = 'A3') = 500000 AND sum(cr) FILTER (WHERE account_code = 'L2') = 500000
          AND count(*) = 2 AND NOT bool_or(group_one_sided)
     FROM sofp_ledger_legs(now() + interval '1 minute')
    WHERE transaction_group_id = (SELECT ledger_group_id FROM funder_offplatform_rent_payments WHERE id = pg_temp.pid('b3'))));
SELECT pg_temp.check('Cover fee: 10,000 from Brian''s float to Sam (proxy agent), charged',
  (SELECT cover_fee_status = 'charged' AND proxy_agent_id = :sam FROM funder_offplatform_rent_payments WHERE id = pg_temp.pid('b3'))
  AND (SELECT sum(amount) FROM general_ledger WHERE user_id = :sam AND category = 'agent_commission' AND direction = 'cash_in') = 10000
  AND (SELECT sum(amount) FROM general_ledger WHERE user_id = :brian AND category = 'welile_cover_fee' AND wallet_bucket = 'float') = 10000);
SELECT pg_temp.check('Brian''s float: 20,000 - 10,000 fee = 10,000, nothing held any more',
  funder_float_available(:brian) = 10000 AND funder_pending_hold(:brian) = 0, funder_float_available(:brian)::text);
SELECT pg_temp.check('agent Peter: 1% (5,000) + UGX 5,000 bonus',
  (SELECT sum(amount) FROM general_ledger WHERE user_id = :peter AND category = 'agent_commission_earned' AND direction = 'cash_in') = 10000);
SELECT pg_temp.check('the bonus used the payout trigger''s key (can never be paid twice)',
  EXISTS (SELECT 1 FROM general_ledger WHERE idempotency_key = 'agent-posted-rent-bonus-' || pg_temp.plan(3)::text));
SELECT pg_temp.check('no 2% fund-in commission is left waiting (the Cover fee paid the proxy agent)',
  NOT EXISTS (SELECT 1 FROM commission_fund_in_candidates
               WHERE portfolio_id = (SELECT (j->>'portfolio_id')::uuid FROM v WHERE k = 'a_b3') AND state = 'pending'));
SELECT pg_temp.check('WLR receipt saved against the payment, readable by its code',
  (SELECT get_landlord_payout_receipt(receipt_code)->>'receipt_number' = (SELECT j->>'receipt_number' FROM v WHERE k = 'a_b3')
     FROM landlord_payout_receipts WHERE payout_id = pg_temp.pid('b3')));
SELECT pg_temp.check('every approval group balances on mapped accounts (no new violations)',
  NOT EXISTS (SELECT 1 FROM ledger_mapped_balance_violations v2 JOIN general_ledger g ON g.transaction_group_id = v2.transaction_group_id
               WHERE g.source_table IN ('funder_offplatform_rent_payments', 'rent_requests') ));
SELECT pg_temp.expect_error('a later landlord payout for this plan is refused',
  format('INSERT INTO landlord_payouts (agent_id, landlord_id, rent_request_id, amount, landlord_phone, landlord_name, mobile_money_provider) VALUES (%L, %L, %L, 500000, ''0772123456'', ''Okello'', ''mtn'')',
         :peter, '1a1a1a1a-0000-4000-8000-000000000001', pg_temp.plan(3)), 'DIRECT_PAY_LANDLORD_PAID%');
SELECT pg_temp.check('approving again does nothing (not_pending)',
  direct_pay_approve(pg_temp.pid('b3'), (SELECT j->>'otp' FROM v WHERE k = 'otp_b3'), 'again', NULL)->>'code' = 'not_pending');

-- ============================================================ approve: Grace, R1, flagged, no proxy agent
INSERT INTO v VALUES ('otp_g1', direct_pay_otp_issue(:lucy, pg_temp.pid('g1')));
SELECT pg_temp.check('flagged without a reason: flag_reason_required',
  direct_pay_approve(pg_temp.pid('g1'), (SELECT j->>'otp' FROM v WHERE k = 'otp_g1'), 'Okello confirmed both', NULL)->>'code' = 'flag_reason_required');
INSERT INTO v VALUES ('a_g1', direct_pay_approve(pg_temp.pid('g1'), (SELECT j->>'otp' FROM v WHERE k = 'otp_g1'),
  'Okello confirmed 450,000 + 50,000 on Tuesday', 'Second SMS was blurry; landlord read both TIDs back'));
SELECT pg_temp.check('flagged with a reason: approved', (SELECT (j->>'ok')::boolean FROM v WHERE k = 'a_g1'), (SELECT j::text FROM v WHERE k = 'a_g1'));
SELECT pg_temp.check('no proxy agent: the Cover fee is kept as Welile revenue',
  (SELECT cover_fee_status = 'kept' FROM funder_offplatform_rent_payments WHERE id = pg_temp.pid('g1'))
  AND EXISTS (SELECT 1 FROM general_ledger WHERE idempotency_key = 'opcover-' || pg_temp.pid('g1')::text
                AND ledger_scope = 'platform' AND category = 'welile_cover_fee' AND direction = 'cash_in'));
SELECT pg_temp.check('Grace''s float: 50,000 - 10,000 (R1 fee) - 10,000 held for R4 = 30,000 available',
  funder_float_available(:grace) = 30000, funder_float_available(:grace)::text);

-- ============================================================ the same TID cannot be approved twice
SELECT pg_temp.as_user(:grace);
INSERT INTO v VALUES ('g5', direct_pay_claim(pg_temp.plan(5)));
SELECT direct_pay_record_proof(:grace, pg_temp.pid('g5'), :grace || '/r5.jpg', 'sha-g5', 'mtn', NULL, NULL,
  jsonb_build_object('status', 'read', 'tid', 'MP 231117 3030', 'amount', 500000, 'phone', '0772123456', 'paid_at', (now() + interval '1 minute')::text));
SELECT pg_temp.as_user(:lucy);
INSERT INTO v VALUES ('otp_g5', direct_pay_otp_issue(:lucy, pg_temp.pid('g5')));
SELECT pg_temp.check('a TID already approved on another payment: tid_already_approved, nothing created',
  (SELECT j->>'code' = 'tid_already_approved' FROM (SELECT direct_pay_approve(pg_temp.pid('g5'), (SELECT j->>'otp' FROM v WHERE k = 'otp_g5'),
     'Okello says yes', 'tid_used_before: checking') j) s));
SELECT pg_temp.check('...the payment is still pending and R5 is not funded',
  (SELECT status = 'pending' FROM funder_offplatform_rent_payments WHERE id = pg_temp.pid('g5'))
  AND (SELECT funded_at IS NULL FROM rent_requests WHERE id = pg_temp.plan(5)));

-- ============================================================ OTP limits
UPDATE direct_pay_landlord_otps SET expires_at = now() - interval '1 second' WHERE id = (SELECT (j->>'challenge_id')::uuid FROM v WHERE k = 'otp_g5');
SELECT pg_temp.check('expired code: otp_expired',
  direct_pay_approve(pg_temp.pid('g5'), (SELECT j->>'otp' FROM v WHERE k = 'otp_g5'), 'x', 'y')->>'code' = 'otp_expired');
INSERT INTO v VALUES ('otp_g5b', direct_pay_otp_issue(:lucy, pg_temp.pid('g5')));
SELECT direct_pay_approve(pg_temp.pid('g5'), '111111', 'x', 'y');
SELECT direct_pay_approve(pg_temp.pid('g5'), '222222', 'x', 'y');
SELECT pg_temp.check('third wrong code locks it',
  direct_pay_approve(pg_temp.pid('g5'), '333333', 'x', 'y')->>'attempts_left' = '0');
SELECT pg_temp.check('locked: even the right code is refused',
  direct_pay_approve(pg_temp.pid('g5'), (SELECT j->>'otp' FROM v WHERE k = 'otp_g5b'), 'x', 'y')->>'code' = 'otp_locked');
SELECT direct_pay_otp_issue(:lucy, pg_temp.pid('g5'));
SELECT direct_pay_otp_issue(:lucy, pg_temp.pid('g5'));
SELECT direct_pay_otp_issue(:lucy, pg_temp.pid('g5'));
SELECT pg_temp.check('at most 5 codes an hour per payment',
  direct_pay_otp_issue(:lucy, pg_temp.pid('g5'))->>'code' = 'too_many_codes');

-- ============================================================ reject: Grace, R4
SELECT pg_temp.check('reject without a reason: reason_required', direct_pay_reject(pg_temp.pid('g4'), ' ')->>'code' = 'reason_required');
SELECT pg_temp.check('reject: ok', (direct_pay_reject(pg_temp.pid('g4'), 'Okello says nothing arrived on Tuesday')->>'ok')::boolean);
SELECT pg_temp.check('rejected: proofs rejected, fee hold released, plan back in the pool',
  (SELECT status = 'rejected' AND cover_fee_status = 'waived' AND reject_note LIKE 'Okello%' FROM funder_offplatform_rent_payments WHERE id = pg_temp.pid('g4'))
  AND NOT EXISTS (SELECT 1 FROM funder_offplatform_rent_proofs WHERE payment_id = pg_temp.pid('g4') AND status <> 'rejected'));
SELECT pg_temp.check('rejected plan is free again', EXISTS (SELECT 1 FROM v_partner_self_fundable_plans WHERE rent_request_id = pg_temp.plan(4)));
SELECT pg_temp.check('after the reject only R5''s fee is held: 40,000 - 10,000 = 30,000 available',
  funder_float_available(:grace) = 30000, funder_float_available(:grace)::text);

-- ============================================================ a tenant who still owes cannot get a second plan
SET LOCAL session_replication_role = replica;
INSERT INTO rent_requests (id, tenant_id, landlord_id, agent_id, rent_amount, duration_days, access_fee, request_fee,
                           total_repayment, daily_repayment, status, tenancy_status, coo_reviewed_at, funder_visible)
SELECT 'a0a0a0a0-0000-4000-8000-000000000011', tenant_id, landlord_id, agent_id, 300000, 30, 0, 0, 360000, 12000,
       'coo_approved', 'active', now(), true
  FROM rent_requests WHERE id = pg_temp.plan(3);
SET LOCAL session_replication_role = origin;
SELECT pg_temp.as_user(:grace);
SELECT pg_temp.check('claiming a plan whose tenant still owes on R3: tenant_still_owes',
  direct_pay_claim('a0a0a0a0-0000-4000-8000-000000000011')->>'code' = 'tenant_still_owes');
SELECT pg_temp.as_user(:lucy);

-- ============================================================ the repaying gate still guards ordinary plans
SET LOCAL session_replication_role = replica;
UPDATE rent_requests SET status = 'funded', funded_at = now() WHERE id = pg_temp.plan(8);
SET LOCAL session_replication_role = origin;
UPDATE rent_requests SET status = 'repaying' WHERE id = pg_temp.plan(8);
SELECT pg_temp.check('a plan with no landlord payment still cannot jump to repaying',
  (SELECT status = 'funded' FROM rent_requests WHERE id = pg_temp.plan(8)));

-- ============================================================ who may call what
SELECT pg_temp.check('the browser cannot issue or mark a landlord code',
  NOT has_function_privilege('authenticated', 'direct_pay_otp_issue(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'direct_pay_otp_mark(uuid,boolean,text)', 'EXECUTE'));
SELECT pg_temp.check('the browser can call queue, authorize, approve, reject (each checks the role)',
  has_function_privilege('authenticated', 'direct_pay_ops_queue(text,boolean,timestamptz,uuid,integer)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'direct_pay_otp_authorize(uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'direct_pay_approve(uuid,text,text,text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'direct_pay_reject(uuid,text)', 'EXECUTE'));
SELECT pg_temp.check('nobody reads the code table from the browser',
  NOT has_table_privilege('authenticated', 'direct_pay_landlord_otps', 'SELECT'));

SELECT 'FAIL' AS r, name, detail FROM t_results WHERE NOT ok ORDER BY n;
SELECT 'passed ' || count(*) FILTER (WHERE ok) || ' / ' || count(*) AS summary FROM t_results;
ROLLBACK;
