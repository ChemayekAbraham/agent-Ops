-- Co-support Phase 4 (empty houses): independent scenarios on a fresh DB with Phases 1 + 4 applied.
\i harness.sql

CREATE FUNCTION hh_house(p_rent int DEFAULT 300000) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid; ag uuid := tt_person(15, 0, true, false, 'Agent House');
BEGIN
  INSERT INTO house_listings (agent_id, title, district, monthly_rent, image_urls)
  VALUES (ag, '2-bedroom house', 'Wakiso', p_rent, ARRAY['https://x/house.jpg']) RETURNING id INTO v;
  RETURN v;
END $$;
CREATE FUNCTION hh_listed(p_partner uuid, p_house uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM tt_as(p_partner);
  r := agent_list_empty_house_opportunities(p_limit := 100);
  RETURN EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(r->'rows', r->'items', r->'houses', '[]'::jsonb)) e
                  WHERE (e->>'id')::uuid = p_house OR (e->>'house_id')::uuid = p_house);
END $$;
-- A shared house accepted by two partners: (a, b, house, invite, lead portfolio, invitee portfolio)
CREATE FUNCTION hh_pair(OUT a uuid, OUT b uuid, OUT h uuid, OUT inv uuid, OUT pa uuid, OUT pb uuid) LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  a := tt_person(15, 200000); b := tt_person(20, 200000); h := hh_house(300000);
  PERFORM tt_as(a); r := co_support_create_house(h);
  PERFORM tt_as(b); PERFORM co_support_accept(r->>'code');
  inv := (r->>'id')::uuid;
  SELECT lead_portfolio_id, invitee_portfolio_id INTO pa, pb FROM co_support_invites WHERE id = inv;
  PERFORM tt_as(NULL);
END $$;
CREATE FUNCTION hh_ops() RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE o uuid := tt_person(15, 0, true, false, 'Ops Person');
BEGIN INSERT INTO t_staff VALUES (o); RETURN o; END $$;

-- ---------------------------------------------------------------- sharing a house
CALL tt_run('H01', 'Share a house: halves, hold, hidden from the feed and from every other claim path', $t$
DECLARE a uuid := tt_person(15, 200000); c uuid := tt_person(15, 400000); h uuid := hh_house(300000); r jsonb;
BEGIN
  ASSERT hh_listed(c, h), 'listed before';
  PERFORM tt_as(a); r := co_support_create_house(h);
  ASSERT r->>'kind' = 'house' AND r->>'status' = 'open' AND r->>'house_title' = '2-bedroom house' AND r->>'city' = 'Wakiso', 'json ' || r;
  ASSERT (r->>'your_share')::numeric = 153000 AND (r->>'partner_share')::numeric = 153000 AND (r->>'plan_amount')::numeric = 306000, 'halves';
  ASSERT (r->>'your_monthly_rent_profit_share')::numeric = 22950, 'rps';
  ASSERT funder_float_available(a) = 47000, 'hold';
  ASSERT house_has_live_claim(h), 'live claim';
  ASSERT NOT hh_listed(c, h), 'hidden from feed';
  PERFORM tt_as(a);
  ASSERT (co_support_create_house(h)->>'idempotent_replay')::boolean, 'replay';
  PERFORM tt_as(c);
  ASSERT tt_err(format('select co_support_create_house(%L)', h)) LIKE 'HOUSE_NOT_AVAILABLE%', 'other share';
  ASSERT tt_err(format('select partner_support_houses(ARRAY[%L]::uuid[], 1, NULL, NULL)', h)) LIKE 'HOUSES_UNAVAILABLE%', 'other single support';
  ASSERT tt_err(format('select co_support_create(%L)', h)) LIKE 'PLAN_NOT_AVAILABLE%', 'house id is not a Rent Plan';
  PERFORM tt_as(a);
  ASSERT tt_err(format('select co_support_create_house(%L)', hh_house(99999))) LIKE 'CO_SUPPORT_PLAN_TOO_SMALL%', 'too small';
END $t$);

CALL tt_run('H02', 'Accept: both halves wait for Partner Ops, nothing debited, both halves held', $t$
DECLARE f record; j jsonb;
BEGIN
  SELECT * INTO f FROM hh_pair();
  ASSERT (SELECT status FROM co_support_invites WHERE id = f.inv) = 'completed', 'invite completed';
  ASSERT (SELECT count(*) FROM partner_supported_houses WHERE co_support_id = f.inv AND status = 'pending'
            AND principal = 153000 AND rent_amount = 150000 AND proxy_fee = 3000) = 2, 'two pending rows';
  ASSERT (SELECT count(*) FROM funder_pending_portfolios WHERE portfolio_id IN (f.pa, f.pb) AND status = 'pending'
            AND source = 'self_managed_house' AND amount = 153000) = 2, 'two pending portfolios';
  ASSERT (SELECT count(*) FROM investor_portfolios WHERE id IN (f.pa, f.pb) AND status = 'pending_ops_approval') = 2, 'portfolios pending';
  ASSERT tt_bal(f.a) = 200000 AND tt_bal(f.b) = 200000, 'nothing debited';
  ASSERT funder_float_available(f.a) = 47000 AND funder_float_available(f.b) = 47000, 'both halves held';
  PERFORM tt_as(f.b); j := co_support_my_invites()->0;
  ASSERT j->>'kind' = 'house' AND (j->>'awaiting_partner_ops')::boolean AND (j->>'your_monthly_rent_profit_share')::numeric = 30600, 'invitee json ' || j;
  ASSERT house_has_live_claim(f.h), 'still claimed';
  ASSERT NOT EXISTS (SELECT 1 FROM co_support_integrity_check()), 'integrity';
END $t$);

-- ---------------------------------------------------------------- Partner Ops decides for the pair
CALL tt_run('H03', 'Approving ONE half approves both: two debits, two fees, both earning', $t$
DECLARE f record; ops uuid := hh_ops();
BEGIN
  SELECT * INTO f FROM hh_pair();
  PERFORM tt_as(ops); PERFORM approve_pending_portfolio(f.pb);
  ASSERT (SELECT count(*) FROM partner_supported_houses WHERE co_support_id = f.inv AND status = 'active') = 2, 'both active';
  ASSERT (SELECT count(*) FROM investor_portfolios WHERE id IN (f.pa, f.pb) AND status = 'active') = 2, 'both portfolios';
  ASSERT (SELECT count(*) FROM funder_pending_portfolios WHERE portfolio_id IN (f.pa, f.pb) AND status = 'approved') = 2, 'both approved';
  ASSERT tt_bal(f.a) = 47000 AND tt_bal(f.b) = 47000, 'both debited 153,000';
  ASSERT (SELECT count(*) FROM general_ledger WHERE idempotency_key LIKE 'ssfee-%' AND amount = 3000
            AND idempotency_key IN (SELECT 'ssfee-' || commitment_id FROM partner_supported_houses WHERE co_support_id = f.inv)) = 2, 'two fees';
  ASSERT (SELECT count(*) FROM partner_self_commitments WHERE id IN (SELECT commitment_id FROM partner_supported_houses WHERE co_support_id = f.inv) AND status = 'active') = 2, 'commitments active';
  ASSERT (SELECT count(*) FROM t_house_notices WHERE row_id IN (SELECT id FROM partner_supported_houses WHERE co_support_id = f.inv)) = 2, 'both partners notified';
  ASSERT NOT EXISTS (SELECT 1 FROM agent_landlord_float_allocations), 'no landlord float for a house';
  ASSERT NOT EXISTS (SELECT 1 FROM co_support_integrity_check()), 'integrity';
  PERFORM tt_as(ops);
  ASSERT approve_pending_portfolio(f.pa) IS NOT NULL OR true, 'second approve is harmless';
  ASSERT tt_bal(f.a) = 47000, 'no double debit';
END $t$);

CALL tt_run('H04', 'Rejecting ONE half rejects both: floats freed, house back on the feed', $t$
DECLARE f record; ops uuid := hh_ops(); c uuid := tt_person(15, 0);
BEGIN
  SELECT * INTO f FROM hh_pair();
  PERFORM tt_as(ops); PERFORM reject_pending_portfolio(f.pa, 'house failed the site check');
  ASSERT (SELECT count(*) FROM partner_supported_houses WHERE co_support_id = f.inv AND status = 'cancelled') = 2, 'both cancelled';
  ASSERT (SELECT count(*) FROM funder_pending_portfolios WHERE portfolio_id IN (f.pa, f.pb) AND status = 'rejected') = 2, 'both rejected';
  ASSERT funder_float_available(f.a) = 200000 AND funder_float_available(f.b) = 200000, 'holds freed';
  ASSERT (SELECT status || '/' || close_reason FROM co_support_invites WHERE id = f.inv) = 'cancelled/rejected_by_partner_ops', 'invite';
  ASSERT hh_listed(c, f.h), 'back on the feed';
END $t$);

CALL tt_run('H05', 'Approval fails for one partner (float drained): neither half is approved', $t$
DECLARE f record; ops uuid := hh_ops();
BEGIN
  SELECT * INTO f FROM hh_pair();
  INSERT INTO general_ledger (amount, direction, category, user_id, source_table, ledger_scope, wallet_bucket)
  VALUES (150000, 'cash_out', 'withdrawal', f.b, 'test', 'wallet', 'float');
  PERFORM tt_as(ops);
  ASSERT tt_err(format('select approve_pending_portfolio(%L)', f.pa)) LIKE 'INSUFFICIENT_WALLET_BALANCE%', 'refused';
  ASSERT (SELECT count(*) FROM partner_supported_houses WHERE co_support_id = f.inv AND status = 'pending') = 2, 'both still pending';
  ASSERT tt_bal(f.a) = 200000, 'lead not debited';
END $t$);

-- ---------------------------------------------------------------- after approval
CALL tt_run('H06', 'Staff cancels one approved half: both cancel, two refunds recorded, house back', $t$
DECLARE f record; ops uuid := hh_ops(); c uuid := tt_person(15, 0);
BEGIN
  SELECT * INTO f FROM hh_pair();
  PERFORM tt_as(ops); PERFORM approve_pending_portfolio(f.pa);
  UPDATE partner_supported_houses SET status = 'cancelled', cancelled_at = now() WHERE co_support_id = f.inv AND partner_id = f.a;
  ASSERT (SELECT count(*) FROM partner_supported_houses WHERE co_support_id = f.inv AND status = 'cancelled') = 2, 'both';
  ASSERT (SELECT status || '/' || close_reason FROM co_support_invites WHERE id = f.inv) = 'cancelled/funding_cancelled', 'invite';
  ASSERT (SELECT count(*) FROM audit_logs WHERE action_type = 'co_support_funding_cancelled' AND record_id = f.inv::text
            AND (metadata->>'amount_paid')::numeric = 153000) = 2, 'refunds';
  ASSERT hh_listed(c, f.h), 'back on the feed';
  ASSERT NOT EXISTS (SELECT 1 FROM co_support_integrity_check()), 'integrity';
END $t$);

CALL tt_run('H07', 'Partner Ops cancel action: refuses a pending pair, cancels an approved one', $t$
DECLARE f record; ops uuid := hh_ops(); r jsonb;
BEGIN
  SELECT * INTO f FROM hh_pair();
  PERFORM tt_as(ops);
  ASSERT tt_err(format('select co_support_staff_cancel(%L, %L)', f.inv, 'landlord withdrew the house')) LIKE 'PENDING_APPROVAL%', 'pending';
  PERFORM approve_pending_portfolio(f.pa);
  r := co_support_staff_cancel(f.inv, 'landlord withdrew the house');
  ASSERT (r->>'success')::boolean AND r->>'kind' = 'house' AND jsonb_array_length(r->'refunds_due') = 2
     AND (r->'refunds_due'->0->>'partner_id')::uuid = f.a, 'result ' || r;
END $t$);

-- ---------------------------------------------------------------- the sharer's other choices
CALL tt_run('H08', 'Pay the whole house alone: the one-partner path (pending Partner Ops)', $t$
DECLARE a uuid := tt_person(15, 400000); h uuid := hh_house(300000); r jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create_house(h);
  r := co_support_fund_alone((r->>'id')::uuid);
  ASSERT (r->>'ok')::boolean AND r->>'status' = 'pending_ops_approval', 'result ' || r;
  ASSERT (SELECT count(*) FROM partner_supported_houses WHERE house_id = h AND co_support_id IS NULL AND status = 'pending' AND principal = 306000) = 1, 'single row';
  ASSERT funder_float_available(a) = 94000, 'full amount held';
END $t$);

CALL tt_run('H09', 'Decline, same-link re-invite, new link and cancel work for houses', $t$
DECLARE a uuid := tt_person(15, 200000); b uuid := tt_person(15, 200000); h uuid := hh_house(300000); r jsonb; code1 text; r2 jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create_house(h); code1 := r->>'code';
  PERFORM tt_as(b); ASSERT co_support_decline(code1)->>'status' = 'declined', 'declined';
  PERFORM tt_as(a);
  ASSERT co_support_reinvite((r->>'id')::uuid, false)->>'code' = code1, 'same link';
  r2 := co_support_reinvite((r->>'id')::uuid, true);
  ASSERT r2->>'code' <> code1 AND r2->>'kind' = 'house', 'new link';
  ASSERT co_support_cancel((r2->>'id')::uuid)->>'status' = 'cancelled', 'cancel';
  ASSERT funder_float_available(a) = 200000 AND NOT house_has_live_claim(h), 'all freed';
END $t$);

-- ---------------------------------------------------------------- changes during the 48 hours
CALL tt_run('H10', 'Rent changed after sharing: plan_changed, nothing created', $t$
DECLARE a uuid := tt_person(15, 200000); b uuid := tt_person(15, 200000); h uuid := hh_house(300000); r jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create_house(h);
  UPDATE house_listings SET monthly_rent = 320000 WHERE id = h;
  PERFORM tt_as(b); r := co_support_accept(r->>'code');
  ASSERT r->>'reason' = 'plan_changed', 'result ' || r;
  ASSERT NOT EXISTS (SELECT 1 FROM partner_supported_houses WHERE house_id = h), 'nothing created';
  ASSERT funder_float_available(a) = 200000 AND funder_float_available(b) = 200000, 'no holds';
END $t$);

CALL tt_run('H11', 'House let to a tenant meanwhile: plan_unavailable, nothing created', $t$
DECLARE a uuid := tt_person(15, 200000); b uuid := tt_person(15, 200000); h uuid := hh_house(300000); r jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create_house(h);
  UPDATE house_listings SET tenant_id = gen_random_uuid(), status = 'occupied' WHERE id = h;
  PERFORM tt_as(b); r := co_support_accept(r->>'code');
  ASSERT r->>'status' = 'plan_unavailable' AND r->>'reason' = 'house_not_available', 'result ' || r;
END $t$);

CALL tt_run('H12', 'Empty-house switch off: house sharing paused, Rent Plan sharing unaffected', $t$
DECLARE a uuid := tt_person(15, 400000); b uuid := tt_person(15, 200000); h uuid := hh_house(300000); r jsonb;
BEGIN
  PERFORM tt_as(a); r := co_support_create_house(h);
  UPDATE pipeline_switches SET is_on = false WHERE key = 'funders_empty_houses';
  PERFORM tt_as(b);
  ASSERT co_support_preview(r->>'code')->>'reason' = 'paused', 'preview paused';
  ASSERT tt_err(format('select co_support_accept(%L)', r->>'code')) LIKE 'CO_SUPPORT_UNAVAILABLE%', 'accept paused';
  PERFORM tt_as(a);
  ASSERT co_support_create(tt_plan(300000))->>'kind' = 'rent_plan', 'rent plan still works';
  UPDATE pipeline_switches SET is_on = true WHERE key = 'funders_empty_houses';
END $t$);

-- ---------------------------------------------------------------- no mixing
CALL tt_run('H13', 'A house supported by one partner can never get a co-support row (and the reverse)', $t$
DECLARE d uuid := tt_person(15, 400000); h uuid := hh_house(300000); f record;
BEGIN
  PERFORM tt_as(d); PERFORM partner_support_houses(ARRAY[h], 1, NULL, NULL);
  ASSERT tt_err(format($q$insert into partner_supported_houses (partner_id, house_id, principal, status, co_support_id)
      values (%L, %L, 1, 'pending', (select id from co_support_invites limit 1))$q$, tt_person(), h)) <> 'NO ERROR', 'mixed refused';
  SELECT * INTO f FROM hh_pair();
  ASSERT tt_err(format($q$insert into partner_supported_houses (partner_id, house_id, principal, status)
      values (%L, %L, 1, 'pending')$q$, tt_person(), f.h)) <> 'NO ERROR', 'single on a shared house refused';
END $t$);

CALL tt_run('H15', 'Partner Ops list shows shared Rent Plans and houses with both partners; others are refused', $t$
DECLARE f record; ops uuid := hh_ops(); r jsonb; e jsonb; x uuid := tt_person(15, 400000); y uuid := tt_person(15, 200000); pr jsonb;
BEGIN
  SELECT * INTO f FROM hh_pair();
  PERFORM tt_as(x); pr := co_support_create(tt_plan(300000));
  PERFORM tt_as(y); PERFORM co_support_accept(pr->>'code');
  PERFORM tt_as(f.a);
  ASSERT tt_err('select co_support_staff_list()') LIKE 'NOT_AUTHORIZED%', 'partner refused';
  PERFORM tt_as(ops); r := co_support_staff_list();
  SELECT el INTO e FROM jsonb_array_elements(r) el WHERE (el->>'invite_id')::uuid = f.inv;
  ASSERT e->>'kind' = 'house' AND e->>'status' = 'awaiting_approval' AND jsonb_array_length(e->'partners') = 2
     AND (e->'partners'->0->>'amount')::numeric = 153000, 'house row ' || e;
  SELECT el INTO e FROM jsonb_array_elements(r) el WHERE (el->>'invite_id')::uuid = (pr->>'id')::uuid;
  ASSERT e->>'kind' = 'rent_plan' AND e->>'status' = 'funded' AND (e->>'landlord_paid_out')::numeric = 0, 'plan row ' || e;
END $t$);

CALL tt_run('H14', 'Grants: house share is for signed-in partners; helpers are closed', $t$
  ASSERT has_function_privilege('authenticated', 'public.co_support_create_house(uuid)', 'EXECUTE'), 'auth';
  ASSERT NOT has_function_privilege('anon', 'public.co_support_create_house(uuid)', 'EXECUTE'), 'anon';
  ASSERT NOT has_function_privilege('authenticated', 'public._co_support_open_house_half(uuid,uuid,numeric,numeric,text)', 'EXECUTE'), 'helper';
  ASSERT NOT has_function_privilege('authenticated', 'public._co_support_pair_pending_portfolios(uuid)', 'EXECUTE'), 'pair helper';
$t$);

SELECT id, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, title, COALESCE(detail, '') AS detail FROM tt_result ORDER BY id;
SELECT count(*) FILTER (WHERE ok) || ' passed, ' || count(*) FILTER (WHERE NOT ok) || ' failed' AS summary FROM tt_result;
SELECT 'integrity rows after suite: ' || count(*) FROM co_support_integrity_check();
