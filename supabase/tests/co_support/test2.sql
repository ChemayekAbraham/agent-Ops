-- Co-support Phase 1: test-master suite 2. Independent scenarios: each one makes
-- its own people and plans, runs in its own sub-transaction, and records
-- pass/fail, so one failure never hides the others. Run on a freshly reset DB.
\set ON_ERROR_STOP 1
SET client_min_messages = warning;

CREATE TABLE tt_result (id text PRIMARY KEY, title text, ok boolean, detail text);
CREATE SEQUENCE tt_seq;

CREATE FUNCTION tt_person(p_rate numeric DEFAULT 15, p_float numeric DEFAULT 0, p_signed boolean DEFAULT true,
                          p_partner boolean DEFAULT true, p_name text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v uuid := gen_random_uuid();
BEGIN
  INSERT INTO profiles (id, full_name) VALUES (v, COALESCE(p_name, 'Person' || nextval('tt_seq') || ' Test'));
  IF p_partner THEN INSERT INTO t_partners (user_id, signed, rate) VALUES (v, p_signed, p_rate); END IF;
  IF p_float > 0 THEN
    INSERT INTO general_ledger (amount, direction, category, user_id, source_table, ledger_scope, wallet_bucket)
    VALUES (p_float, 'cash_in', 'float_deposit', v, 'test', 'wallet', 'float');
  END IF;
  RETURN v;
END $$;
CREATE FUNCTION tt_credit(p uuid, amt numeric) RETURNS void LANGUAGE sql AS $$
  INSERT INTO general_ledger (amount, direction, category, user_id, source_table, ledger_scope, wallet_bucket)
  VALUES (amt, 'cash_in', 'float_deposit', p, 'test', 'wallet', 'float') $$;
CREATE FUNCTION tt_plan(p_rent numeric) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid; l uuid; tn uuid := tt_person(15, 0, true, false, 'Tenant' || nextval('tt_seq') || ' X');
        ag uuid := tt_person(15, 0, true, false, 'Agent X');
BEGIN
  INSERT INTO landlords (name, phone) VALUES ('Landlord', '0700000001') RETURNING id INTO l;
  INSERT INTO rent_requests (tenant_id, agent_id, landlord_id, rent_amount, request_city, house_image_urls)
  VALUES (tn, ag, l, p_rent, 'Kampala', ARRAY['https://x/h.jpg']) RETURNING id INTO v;
  RETURN v;
END $$;
CREATE FUNCTION tt_as(p uuid) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('request.jwt.claim.sub', COALESCE(p::text, ''), false) $$;
CREATE FUNCTION tt_err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'NO ERROR'; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
CREATE FUNCTION tt_bal(p uuid) RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT get_user_float_available_balance(p) $$;
CREATE FUNCTION tt_plan_money(p_rr uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT (SELECT count(*) FROM partner_self_funding_lines WHERE rent_request_id = p_rr) || ' lines, '
      || (SELECT count(*) FROM agent_landlord_float_allocations WHERE rent_request_id = p_rr) || ' allocations, '
      || (SELECT count(*) FROM investor_portfolios ip JOIN funder_pending_portfolios f ON f.portfolio_id = ip.id
            JOIN partner_self_funding_lines l ON l.commitment_id = f.commitment_id WHERE l.rent_request_id = p_rr) || ' portfolios' $$;

-- Runs one scenario body; records pass/fail. Any error (incl. failed ASSERT) = fail, changes undone.
CREATE PROCEDURE tt_run(p_id text, p_title text, p_body text) LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    IF p_body ~* '^\s*declare' THEN
      EXECUTE 'DO $body$ ' || p_body || ' $body$';
    ELSE
      EXECUTE 'DO $body$ BEGIN ' || p_body || ' END $body$';
    END IF;
    INSERT INTO tt_result VALUES (p_id, p_title, true, NULL);
  EXCEPTION WHEN OTHERS OR assert_failure THEN
    INSERT INTO tt_result VALUES (p_id, p_title, false, SQLERRM);
  END;
  PERFORM tt_as(NULL);
END $$;

-- ---------------------------------------------------------------- security
CALL tt_run('S01', 'Grants: browsers can only reach the 8 co_support functions; anon only the preview', $t$
  ASSERT has_function_privilege('anon', 'public.co_support_preview(text)', 'EXECUTE'), 'anon preview';
  ASSERT NOT has_function_privilege('anon', 'public.co_support_create(uuid)', 'EXECUTE'), 'anon create';
  ASSERT NOT has_function_privilege('anon', 'public.co_support_accept(text)', 'EXECUTE'), 'anon accept';
  ASSERT NOT has_function_privilege('anon', 'public.co_support_my_invites()', 'EXECUTE'), 'anon my';
  ASSERT has_function_privilege('authenticated', 'public.co_support_create(uuid)', 'EXECUTE'), 'auth create';
  ASSERT has_function_privilege('authenticated', 'public.co_support_accept(text)', 'EXECUTE'), 'auth accept';
  ASSERT has_function_privilege('authenticated', 'public.co_support_fund_alone(uuid)', 'EXECUTE'), 'auth fund alone';
  ASSERT NOT has_function_privilege('authenticated', 'public._co_support_open_half(uuid,uuid,numeric,numeric,text)', 'EXECUTE'), 'auth open_half';
  ASSERT NOT has_function_privilege('authenticated', 'public._co_support_disburse_landlord_float(uuid)', 'EXECUTE'), 'auth disburse';
  ASSERT NOT has_function_privilege('authenticated', 'public._co_support_lead_checks(uuid,uuid)', 'EXECUTE'), 'auth lead checks';
  ASSERT NOT has_function_privilege('authenticated', 'public._co_support_invite_json(uuid,uuid)', 'EXECUTE'), 'auth json';
  ASSERT NOT has_function_privilege('authenticated', 'public.co_support_integrity_check()', 'EXECUTE'), 'auth integrity';
  ASSERT has_function_privilege('service_role', 'public.co_support_integrity_check()', 'EXECUTE'), 'service integrity';
  ASSERT NOT has_table_privilege('authenticated', 'public.co_support_invites', 'SELECT'), 'auth select table';
  ASSERT NOT has_table_privilege('anon', 'public.co_support_invites', 'SELECT'), 'anon select table';
  ASSERT has_table_privilege('service_role', 'public.co_support_invites', 'UPDATE'), 'service table';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.co_support_invites'::regclass), 'RLS on';
  ASSERT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.co_support_invites'::regclass
                   AND polname = 'mfa_required_for_staff' AND NOT polpermissive), 'MFA policy restrictive';
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname LIKE '%co_support%' AND NOT prosecdef
            AND proname NOT IN ('_co_support_status','_co_support_fmt')) = 0, 'all definer except pure helpers';
  ASSERT (SELECT count(*) FROM pg_proc p WHERE proname LIKE '%co_support%'
            AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')) = 0, 'search_path pinned';
$t$);

CALL tt_run('S02', 'Privacy: each partner sees only their own rate and Rent Profit Share', $t$
DECLARE a uuid := tt_person(15, 400000); d uuid := tt_person(20, 400000, true, true, 'Diana Kato');
        p uuid := tt_plan(300000); r jsonb; rl jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create(p);
  PERFORM tt_as(d); r := co_support_accept(r->>'code');
  ASSERT (r->>'your_monthly_rent_profit_share')::numeric = 30600, 'invitee 20% ' || r;
  PERFORM tt_as(a); rl := co_support_my_invites()->0;
  ASSERT (rl->>'your_monthly_rent_profit_share')::numeric = 22950, 'lead 15% ' || rl;
  ASSERT NOT EXISTS (SELECT 1 FROM jsonb_each(rl) e WHERE e.value::text IN ('30600', '20'))
     AND NOT EXISTS (SELECT 1 FROM jsonb_each(r) e WHERE e.value::text IN ('22950', '15')), 'no cross leak';
  ASSERT NOT (rl ? 'rate') AND NOT (rl ? 'roi_percentage') AND NOT (r ? 'rate'), 'no raw rate keys';
  ASSERT rl->>'partner_first_name' = 'Diana', 'lead sees partner first name only';
  ASSERT (SELECT roi_percentage FROM investor_portfolios WHERE investor_id = d) = 20
     AND (SELECT roi_percentage FROM investor_portfolios WHERE investor_id = a) = 15, 'stamped rates';
  ASSERT (SELECT monthly_rate FROM partner_self_funding_lines WHERE partner_id = d) = 20, 'line rate';
END $t$);

CALL tt_run('S03', 'Odd link codes never error or leak', $t$
DECLARE r jsonb;
BEGIN
  PERFORM tt_as(NULL);
  ASSERT co_support_preview(NULL)->>'found' = 'false', 'null';
  ASSERT co_support_preview('')->>'found' = 'false', 'empty';
  ASSERT co_support_preview('   ')->>'found' = 'false', 'spaces';
  ASSERT co_support_preview($$' OR 1=1 --$$)->>'found' = 'false', 'injection';
  ASSERT co_support_preview(repeat('A', 5000))->>'found' = 'false', 'long';
  PERFORM tt_as(tt_person());
  ASSERT tt_err('select co_support_accept(NULL)') LIKE 'INVITE_NOT_FOUND%', 'accept null';
  ASSERT tt_err($$select co_support_decline('nope')$$) LIKE 'INVITE_NOT_FOUND%', 'decline unknown';
END $t$);

CALL tt_run('S04', 'Codes: case and spaces ignored; anon sees no code, no rate, cannot accept', $t$
DECLARE a uuid := tt_person(15, 200000); p uuid := tt_plan(300000); r jsonb; pv jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create(p);
  PERFORM tt_as(NULL); pv := co_support_preview('  ' || lower(r->>'code') || ' ');
  ASSERT (pv->>'found')::boolean AND pv->>'code' IS NULL AND NOT (pv->>'can_accept')::boolean
     AND pv->>'your_monthly_rent_profit_share' IS NULL AND NOT (pv->>'signed_in')::boolean, 'anon ' || pv;
END $t$);

-- ---------------------------------------------------------------- money edge cases
CALL tt_run('M01', 'Fee switch flips between share and accept: agreed halves are paid', $t$
DECLARE a uuid := tt_person(15, 200000); b uuid := tt_person(15, 200000); p uuid := tt_plan(300000); r jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create(p);
  UPDATE self_support_fee_policy SET enabled = false;
  PERFORM tt_as(b); r := co_support_accept(r->>'code');
  UPDATE self_support_fee_policy SET enabled = true;
  ASSERT tt_bal(a) = 47000 AND tt_bal(b) = 47000, 'each paid 153,000';
  ASSERT (SELECT allocated_amount FROM agent_landlord_float_allocations WHERE rent_request_id = p) = 300000, 'landlord 300,000';
  ASSERT NOT EXISTS (SELECT 1 FROM co_support_integrity_check()), 'integrity';
END $t$);

CALL tt_run('M02', 'Rent changed after sharing: nobody pays, invite closes as plan_changed', $t$
DECLARE a uuid := tt_person(15, 200000); b uuid := tt_person(15, 200000); p uuid := tt_plan(300000); r jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create(p);
  UPDATE rent_requests SET rent_amount = 350000 WHERE id = p;
  PERFORM tt_as(b); r := co_support_accept(r->>'code');
  ASSERT NOT (r->>'ok')::boolean AND r->>'reason' = 'plan_changed', 'result ' || r;
  ASSERT tt_bal(a) = 200000 AND tt_bal(b) = 200000, 'no money moved';
  ASSERT tt_plan_money(p) = '0 lines, 0 allocations, 0 portfolios', tt_plan_money(p);
  ASSERT funder_float_available(a) = 200000, 'hold released';
  PERFORM tt_as(a); r := co_support_create(p);
  ASSERT (r->>'your_share')::numeric = 178500, 'new halves on the new rent ' || r;   -- 357,000 / 2
END $t$);

CALL tt_run('M03', 'Boundaries: 99,999 refused; 100,000 and 100,001 split with each half >= 50,000', $t$
DECLARE a uuid := tt_person(15, 300000); r jsonb;
BEGIN
  PERFORM tt_as(a);
  ASSERT tt_err(format('select co_support_create(%L)', tt_plan(99999))) LIKE 'CO_SUPPORT_PLAN_TOO_SMALL%', '99,999';
  r := co_support_create(tt_plan(100000));
  ASSERT (r->>'plan_amount')::numeric = 102000 AND (r->>'your_share')::numeric = 51000 AND (r->>'partner_share')::numeric = 51000, '100,000 ' || r;
  r := co_support_create(tt_plan(100001));
  -- gross ceil(102001.02/100)*100 = 102,100 -> 51,050 + 51,050; rent 50,001 + 50,000
  ASSERT (r->>'your_share')::numeric = 51050 AND (r->>'partner_share')::numeric = 51050, '100,001 ' || r;
  ASSERT (SELECT lead_rent = 50001 AND invitee_rent = 50000 FROM co_support_invites WHERE id = (r->>'id')::uuid), 'rent halves';
END $t$);

CALL tt_run('M04', 'Hold: a partner cannot promise the same float to two invites', $t$
DECLARE a uuid := tt_person(15, 200000); r jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create(tt_plan(300000));
  ASSERT tt_err(format('select co_support_create(%L)', tt_plan(300000))) LIKE 'PARTNER_FUNDS_SHORT: Your half is UGX 153,000. You have UGX 47,000%', 'second';
  PERFORM co_support_cancel((r->>'id')::uuid);
  ASSERT co_support_create(tt_plan(300000))->>'status' = 'open', 'after cancel';
END $t$);

CALL tt_run('M05', 'Invitee short on float: preview says funds_short with the exact gap', $t$
DECLARE a uuid := tt_person(15, 200000); b uuid := tt_person(15, 0); r jsonb; pv jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create(tt_plan(300000));
  PERFORM tt_as(b); pv := co_support_preview(r->>'code');
  ASSERT pv->>'reason' = 'funds_short' AND (pv->>'float_needed')::numeric = 153000, 'preview ' || pv;
  ASSERT tt_err(format('select co_support_accept(%L)', r->>'code')) LIKE 'PARTNER_FUNDS_SHORT%', 'accept';
END $t$);

CALL tt_run('M06', 'Pay alone without enough float: refused, invite and hold stay', $t$
DECLARE a uuid := tt_person(15, 200000); r jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create(tt_plan(300000));
  ASSERT tt_err(format('select co_support_fund_alone(%L)', r->>'id')) LIKE 'PARTNER_FUNDS_SHORT: The full Rent Plan is UGX 306,000%', 'short';
  ASSERT (SELECT status FROM co_support_invites WHERE id = (r->>'id')::uuid) = 'open', 'still open';
  ASSERT funder_float_available(a) = 47000, 'hold intact';
END $t$);

-- ---------------------------------------------------------------- eligibility changes during the 48 hours
CALL tt_run('E01', 'Sender loses the contract or partner role: accept refused, nothing moves', $t$
DECLARE a uuid := tt_person(15, 200000); b uuid := tt_person(15, 200000); p uuid := tt_plan(300000); r jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create(p);
  UPDATE t_partners SET signed = false WHERE user_id = a;
  PERFORM tt_as(b);
  ASSERT tt_err(format('select co_support_accept(%L)', r->>'code')) LIKE 'LEAD_NOT_ELIGIBLE%', 'unsigned lead';
  UPDATE t_partners SET signed = true WHERE user_id = a;
  DELETE FROM t_partners WHERE user_id = a;
  ASSERT tt_err(format('select co_support_accept(%L)', r->>'code')) LIKE 'LEAD_NOT_ELIGIBLE%', 'not partner';
  ASSERT tt_plan_money(p) = '0 lines, 0 allocations, 0 portfolios' AND tt_bal(b) = 200000, 'nothing moved';
END $t$);

CALL tt_run('E02', 'Agent removed from the plan: plan_unavailable, nothing moves', $t$
DECLARE a uuid := tt_person(15, 200000); b uuid := tt_person(15, 200000); p uuid := tt_plan(300000); r jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create(p);
  UPDATE rent_requests SET agent_id = NULL, assigned_agent_id = NULL WHERE id = p;
  PERFORM tt_as(b); r := co_support_accept(r->>'code');
  ASSERT r->>'status' = 'plan_unavailable', 'result ' || r;
  ASSERT tt_bal(a) = 200000 AND tt_bal(b) = 200000, 'nothing moved';
END $t$);

CALL tt_run('E03', 'Plan booked on another partner''s promissory note: accept refused', $t$
DECLARE a uuid := tt_person(15, 200000); b uuid := tt_person(15, 200000); x uuid := tt_person(); p uuid := tt_plan(300000); r jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create(p);
  INSERT INTO t_booked VALUES (p, x);
  PERFORM tt_as(b);
  ASSERT tt_err(format('select co_support_accept(%L)', r->>'code')) LIKE 'PLAN_BOOKED_BY_OTHER_PARTNER%', 'booked';
  ASSERT (SELECT status FROM co_support_invites WHERE id = (r->>'id')::uuid) = 'open', 'invite open';
END $t$);

CALL tt_run('E04', 'Direct release switched off mid-invite: accept paused, cancel still works', $t$
DECLARE a uuid := tt_person(15, 200000); b uuid := tt_person(15, 200000); r jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create(tt_plan(300000));
  UPDATE pipeline_switches SET is_on = false;
  PERFORM tt_as(b);
  ASSERT tt_err(format('select co_support_accept(%L)', r->>'code')) LIKE 'CO_SUPPORT_UNAVAILABLE%', 'paused';
  ASSERT co_support_preview(r->>'code')->>'reason' = 'paused', 'preview paused';
  PERFORM tt_as(a);
  ASSERT co_support_cancel((r->>'id')::uuid)->>'status' = 'cancelled', 'cancel';
  UPDATE pipeline_switches SET is_on = true;
END $t$);

CALL tt_run('E05', 'Someone else''s unexpired cart hold blocks sharing; my own cart hold gives way', $t$
DECLARE a uuid := tt_person(15, 200000); c uuid := tt_person(15, 200000); p uuid := tt_plan(300000); q uuid := tt_plan(300000);
BEGIN
  INSERT INTO partner_self_plan_claims (rent_request_id, partner_id, amount, expires_at) VALUES (p, c, 300000, now() + interval '10 minutes');
  INSERT INTO partner_self_plan_claims (rent_request_id, partner_id, amount, expires_at) VALUES (q, a, 300000, now() + interval '10 minutes');
  PERFORM tt_as(a);
  ASSERT tt_err(format('select co_support_create(%L)', p)) LIKE 'PLAN_NOT_AVAILABLE%', 'other hold';
  ASSERT co_support_create(q)->>'status' = 'open', 'own hold';
  ASSERT (SELECT status FROM partner_self_plan_claims WHERE rent_request_id = q AND partner_id = a) = 'released', 'own hold released';
END $t$);

CALL tt_run('E06', 'Expiry is exact: expires_at = now() is already expired', $t$
DECLARE a uuid := tt_person(15, 200000); r jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create(tt_plan(300000));
  UPDATE co_support_invites SET expires_at = now() WHERE id = (r->>'id')::uuid;
  ASSERT co_support_preview(r->>'code')->>'status' = 'expired', 'expired';
  ASSERT funder_float_available(a) = 200000, 'hold gone';
END $t$);

-- ---------------------------------------------------------------- who may do what
CALL tt_run('W01', 'Decline: sign-in needed, sender cannot, repeat is harmless', $t$
DECLARE a uuid := tt_person(15, 200000); b uuid := tt_person(); r jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create(tt_plan(300000));
  ASSERT tt_err(format('select co_support_decline(%L)', r->>'code')) LIKE 'OWN_INVITE%', 'lead';
  PERFORM tt_as(NULL);
  ASSERT tt_err(format('select co_support_decline(%L)', r->>'code')) LIKE 'AUTH_REQUIRED%', 'anon';
  PERFORM tt_as(b);
  ASSERT co_support_decline(r->>'code')->>'status' = 'declined', 'first';
  ASSERT (co_support_decline(r->>'code')->>'idempotent_replay')::boolean, 'second';
END $t$);

CALL tt_run('W02', 'Only the sender can cancel, re-invite or pay alone; closed invites stay closed', $t$
DECLARE a uuid := tt_person(15, 400000); b uuid := tt_person(15, 200000); x uuid := tt_person(15, 400000); r jsonb; done jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create(tt_plan(300000));
  PERFORM tt_as(x);
  ASSERT tt_err(format('select co_support_cancel(%L)', r->>'id')) LIKE 'INVITE_NOT_FOUND%', 'cancel';
  ASSERT tt_err(format('select co_support_reinvite(%L, true)', r->>'id')) LIKE 'INVITE_NOT_FOUND%', 'reinvite';
  ASSERT tt_err(format('select co_support_fund_alone(%L)', r->>'id')) LIKE 'INVITE_NOT_FOUND%', 'fund alone';
  PERFORM tt_as(b); done := co_support_accept(r->>'code');
  PERFORM tt_as(a);
  ASSERT co_support_cancel((r->>'id')::uuid)->>'status' = 'completed', 'cancel after completion is a no-op';
  ASSERT tt_err(format('select co_support_reinvite(%L, false)', r->>'id')) LIKE 'INVITE_CLOSED%', 'reinvite completed';
  ASSERT tt_err(format('select co_support_fund_alone(%L)', r->>'id')) LIKE 'INVITE_CLOSED%', 'fund alone completed';
  ASSERT tt_bal(a) = 400000 - 153000, 'no second charge';
  PERFORM tt_as(NULL);
  ASSERT tt_err('select co_support_my_invites()') LIKE 'AUTH_REQUIRED%', 'my invites anon';
  PERFORM tt_as(b);
  ASSERT (co_support_my_invites()->0->>'your_role') = 'invitee', 'invitee list';
END $t$);

-- ---------------------------------------------------------------- lifecycle after funding
CALL tt_run('L01', 'Landlord paid later (disbursed_at): both halves stay earning, anchors unchanged', $t$
DECLARE a uuid := tt_person(15, 200000); b uuid := tt_person(15, 200000); p uuid := tt_plan(300000); r jsonb; anchors text;
BEGIN
  PERFORM tt_as(a); r := co_support_create(p);
  PERFORM tt_as(b); PERFORM co_support_accept(r->>'code');
  SELECT string_agg(payout_anchor_at::text, ',' ORDER BY id) INTO anchors FROM partner_self_commitments WHERE partner_id IN (a, b);
  UPDATE rent_requests SET disbursed_at = now() + interval '1 day' WHERE id = p;
  ASSERT (SELECT string_agg(payout_anchor_at::text, ',' ORDER BY id) FROM partner_self_commitments WHERE partner_id IN (a, b)) = anchors, 'anchors';
  ASSERT (SELECT count(*) FROM partner_self_funding_lines WHERE rent_request_id = p AND status = 'active') = 2, 'active';
END $t$);

CALL tt_run('L02', 'Integrity check is empty for good data and catches a planted problem', $t$
DECLARE a uuid := tt_person(15, 200000); b uuid := tt_person(15, 200000); p uuid := tt_plan(300000); r jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create(p);
  PERFORM tt_as(b); PERFORM co_support_accept(r->>'code');
  ASSERT NOT EXISTS (SELECT 1 FROM co_support_integrity_check()), 'clean';
  UPDATE agent_landlord_float_allocations SET allocated_amount = 150000 WHERE rent_request_id = p;
  UPDATE partner_self_funding_lines SET status = 'idle' WHERE rent_request_id = p AND partner_id = b;
  ASSERT (SELECT count(*) FROM co_support_integrity_check() WHERE rent_request_id = p) = 2, 'caught: ' ||
     (SELECT string_agg(problem, '; ') FROM co_support_integrity_check());
  RAISE EXCEPTION 'tt_undo';   -- undo the planted damage
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'tt_undo' THEN RAISE; END IF;
END $t$);

CALL tt_run('L03', 'Old one-partner funding still works next to co-support', $t$
DECLARE d uuid := tt_person(15, 400000); p uuid := tt_plan(300000); r jsonb;
BEGIN
  PERFORM tt_as(d); r := funder_support_tenant_direct(ARRAY[p], NULL, 1);
  ASSERT r->>'status' = 'active', 'single ' || r;
  ASSERT (SELECT count(*) FROM partner_self_funding_lines WHERE rent_request_id = p AND status = 'active' AND co_support_id IS NULL) = 1, 'line';
  ASSERT (SELECT allocated_amount FROM agent_landlord_float_allocations WHERE rent_request_id = p) = 300000, 'alloc';
  ASSERT tt_bal(d) = 400000 - 306000, 'paid 306,000';
END $t$);

-- ---------------------------------------------------------------- staff cancellation (pair-aware)
CREATE FUNCTION tt_funded_pair(OUT a uuid, OUT b uuid, OUT p uuid, OUT inv uuid) LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  a := tt_person(15, 200000); b := tt_person(15, 200000); p := tt_plan(300000);
  PERFORM tt_as(a); r := co_support_create(p);
  PERFORM tt_as(b); PERFORM co_support_accept(r->>'code');
  inv := (r->>'id')::uuid;
  PERFORM tt_as(NULL);
END $$;
CREATE FUNCTION tt_listed(p uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT EXISTS (SELECT 1 FROM v_partner_self_fundable_plans WHERE rent_request_id = p) $$;

CALL tt_run('X01', 'Staff cancels ONE half''s line: both halves cancel, plan released once, both refunds recorded', $t$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM tt_funded_pair();
  UPDATE partner_self_funding_lines SET status = 'cancelled' WHERE rent_request_id = f.p AND partner_id = f.b;
  ASSERT (SELECT count(*) FROM partner_self_funding_lines WHERE rent_request_id = f.p AND status = 'cancelled') = 2, 'both cancelled';
  ASSERT (SELECT status FROM agent_landlord_float_allocations WHERE rent_request_id = f.p) = 'cancelled', 'float reversed';
  ASSERT (SELECT funded_at IS NULL AND self_funding_partner_id IS NULL FROM rent_requests WHERE id = f.p), 'plan reset';
  ASSERT tt_listed(f.p), 'plan back on the list';
  ASSERT (SELECT status FROM co_support_invites WHERE id = f.inv) = 'cancelled', 'invite closed';
  ASSERT (SELECT count(*) FROM audit_logs WHERE action_type = 'psm_release_self_funding_line' AND record_id = f.p::text) = 1, 'released exactly once';
  ASSERT (SELECT count(*) FROM audit_logs WHERE action_type = 'co_support_funding_cancelled' AND record_id = f.inv::text
            AND (metadata->>'amount_paid')::numeric = 153000) = 2, 'two refunds recorded';
  ASSERT NOT EXISTS (SELECT 1 FROM co_support_integrity_check()), 'integrity clean';
END $t$);

CALL tt_run('X02', 'Staff cancels BOTH lines in one statement: still released exactly once', $t$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM tt_funded_pair();
  UPDATE partner_self_funding_lines SET status = 'cancelled' WHERE rent_request_id = f.p;
  ASSERT (SELECT count(*) FROM audit_logs WHERE action_type = 'psm_release_self_funding_line' AND record_id = f.p::text) = 1, 'once';
  ASSERT tt_listed(f.p), 'listed';
END $t$);

CALL tt_run('X03', 'Partner Ops cancel action: role, reason, then both halves + refunds due', $t$
DECLARE f record; ops uuid := tt_person(15, 0, true, false); r jsonb;
BEGIN
  SELECT * INTO f FROM tt_funded_pair();
  INSERT INTO t_staff VALUES (ops);
  PERFORM tt_as(f.a);
  ASSERT tt_err(format('select co_support_staff_cancel(%L, %L)', f.inv, 'tenant moved out early')) LIKE 'NOT_AUTHORIZED%', 'partner cannot';
  PERFORM tt_as(ops);
  ASSERT tt_err(format('select co_support_staff_cancel(%L, %L)', f.inv, 'short')) LIKE 'A reason of at least 10%', 'reason';
  r := co_support_staff_cancel(f.inv, 'tenant moved out before landlord was paid');
  ASSERT (r->>'success')::boolean AND (r->>'plan_released')::boolean, 'result ' || r;
  ASSERT jsonb_array_length(r->'refunds_due') = 2 AND (r->'refunds_due'->0->>'amount')::numeric = 153000
     AND (r->'refunds_due'->0->>'partner_id')::uuid = f.a, 'refunds ' || r;
  ASSERT tt_listed(f.p), 'listed';
  ASSERT tt_err(format('select co_support_staff_cancel(%L, %L)', f.inv, 'tenant moved out again')) LIKE 'NOT_FUNDED%', 'second time';
END $t$);

CALL tt_run('X04', 'Landlord already partly paid: the Ops action refuses and nothing changes', $t$
DECLARE f record; ops uuid := tt_person(15, 0, true, false);
BEGIN
  SELECT * INTO f FROM tt_funded_pair();
  INSERT INTO t_staff VALUES (ops);
  UPDATE agent_landlord_float_allocations SET paid_out_amount = 100000, status = 'partially_paid' WHERE rent_request_id = f.p;
  PERFORM tt_as(ops);
  ASSERT tt_err(format('select co_support_staff_cancel(%L, %L)', f.inv, 'tenant moved out early')) LIKE 'LANDLORD_ALREADY_PAID%', 'refused';
  ASSERT (SELECT count(*) FROM partner_self_funding_lines WHERE rent_request_id = f.p AND status = 'active') = 2, 'lines untouched';
  ASSERT (SELECT status FROM co_support_invites WHERE id = f.inv) = 'completed', 'invite untouched';
END $t$);

CALL tt_run('X05', 'Release called on one half while the other is live: refused, nothing changes', $t$
DECLARE f record; r jsonb;
BEGIN
  SELECT * INTO f FROM tt_funded_pair();
  r := psm_release_self_funding_line((SELECT id FROM partner_self_funding_lines WHERE rent_request_id = f.p AND partner_id = f.a));
  ASSERT NOT (r->>'success')::boolean AND r->>'error' LIKE 'Co-supported Rent Plan%', 'refused ' || r;
  ASSERT (SELECT status FROM agent_landlord_float_allocations WHERE rent_request_id = f.p) = 'open', 'float kept';
  ASSERT NOT tt_listed(f.p), 'not relisted';
END $t$);

CALL tt_run('X06', 'One-partner cancel path unchanged', $t$
DECLARE d uuid := tt_person(15, 400000); p uuid := tt_plan(300000);
BEGIN
  PERFORM tt_as(d); PERFORM funder_support_tenant_direct(ARRAY[p], NULL, 1);
  UPDATE partner_self_funding_lines SET status = 'cancelled' WHERE rent_request_id = p;
  ASSERT (SELECT status FROM agent_landlord_float_allocations WHERE rent_request_id = p) = 'cancelled', 'reversed';
  ASSERT tt_listed(p), 'listed';
  ASSERT (SELECT count(*) FROM audit_logs WHERE action_type = 'psm_release_self_funding_line' AND record_id = p::text) = 1, 'once';
END $t$);

-- ---------------------------------------------------------------- injected failures (chaos)
CREATE TABLE tt_chaos (what text PRIMARY KEY, who uuid);
CREATE FUNCTION tt_chaos_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM tt_chaos WHERE what = 'debit' AND who = NEW.user_id) AND NEW.category = 'supporter_rent_fund' THEN
    RAISE EXCEPTION 'CHAOS: ledger write failed';
  END IF;
  IF EXISTS (SELECT 1 FROM tt_chaos WHERE what = 'rent_leg') AND NEW.category = 'rent_disbursement' THEN
    RAISE EXCEPTION 'CHAOS: rent leg failed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tt_chaos_ledger BEFORE INSERT ON general_ledger FOR EACH ROW EXECUTE FUNCTION tt_chaos_ledger();
CREATE FUNCTION tt_chaos_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM tt_chaos WHERE what = TG_TABLE_NAME) THEN RAISE EXCEPTION 'CHAOS: % failed', TG_TABLE_NAME; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tt_chaos_n1 BEFORE INSERT ON partner_float_landlord_notices FOR EACH ROW EXECUTE FUNCTION tt_chaos_notice();
CREATE TRIGGER tt_chaos_n2 BEFORE INSERT ON partner_float_agent_notices FOR EACH ROW EXECUTE FUNCTION tt_chaos_notice();

CALL tt_run('C01', 'Second partner''s debit fails: everything rolls back, invite still open, hold kept', $t$
DECLARE a uuid := tt_person(15, 200000); b uuid := tt_person(15, 200000); p uuid := tt_plan(300000); r jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create(p);
  INSERT INTO tt_chaos VALUES ('debit', b);
  PERFORM tt_as(b);
  ASSERT tt_err(format('select co_support_accept(%L)', r->>'code')) LIKE 'CHAOS: ledger write failed%', 'error surfaced';
  DELETE FROM tt_chaos;
  ASSERT tt_plan_money(p) = '0 lines, 0 allocations, 0 portfolios', tt_plan_money(p);
  ASSERT tt_bal(a) = 200000 AND tt_bal(b) = 200000, 'balances';
  ASSERT (SELECT status FROM co_support_invites WHERE id = (r->>'id')::uuid) = 'open', 'open';
  ASSERT funder_float_available(a) = 47000, 'hold kept';
  ASSERT co_support_accept(r->>'code')->>'status' = 'completed', 'retry works';
END $t$);

CALL tt_run('C02', 'Rent leg to the landlord float fails: both debits roll back', $t$
DECLARE a uuid := tt_person(15, 200000); b uuid := tt_person(15, 200000); p uuid := tt_plan(300000); r jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create(p);
  INSERT INTO tt_chaos VALUES ('rent_leg', NULL);
  PERFORM tt_as(b);
  ASSERT tt_err(format('select co_support_accept(%L)', r->>'code')) LIKE 'CHAOS: rent leg failed%', 'error';
  DELETE FROM tt_chaos;
  ASSERT tt_bal(a) = 200000 AND tt_bal(b) = 200000 AND tt_plan_money(p) = '0 lines, 0 allocations, 0 portfolios', 'rolled back';
END $t$);

CALL tt_run('C03', 'Landlord SMS queue fails: funding still completes (notice is best-effort)', $t$
DECLARE a uuid := tt_person(15, 200000); b uuid := tt_person(15, 200000); p uuid := tt_plan(300000); r jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create(p);
  INSERT INTO tt_chaos VALUES ('partner_float_landlord_notices', NULL);
  PERFORM tt_as(b); r := co_support_accept(r->>'code');
  DELETE FROM tt_chaos;
  ASSERT (r->>'ok')::boolean, 'completed';
  ASSERT EXISTS (SELECT 1 FROM t_psm_audit WHERE action = 'landlord_sms_queue_failed'), 'failure audited';
END $t$);

CALL tt_run('C04', 'Agent notice fails: whole funding rolls back (same as one-partner path)', $t$
DECLARE a uuid := tt_person(15, 200000); b uuid := tt_person(15, 200000); p uuid := tt_plan(300000); r jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create(p);
  INSERT INTO tt_chaos VALUES ('partner_float_agent_notices', NULL);
  PERFORM tt_as(b);
  ASSERT tt_err(format('select co_support_accept(%L)', r->>'code')) LIKE 'CHAOS: partner_float_agent_notices failed%', 'error';
  DELETE FROM tt_chaos;
  ASSERT tt_bal(b) = 200000 AND tt_plan_money(p) = '0 lines, 0 allocations, 0 portfolios', 'rolled back';
END $t$);

-- ---------------------------------------------------------------- report
SELECT id, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, title, COALESCE(detail, '') AS detail
  FROM tt_result ORDER BY id;
SELECT count(*) FILTER (WHERE ok) || ' passed, ' || count(*) FILTER (WHERE NOT ok) || ' failed' AS summary FROM tt_result;
SELECT 'integrity rows after suite: ' || count(*) FROM co_support_integrity_check();
