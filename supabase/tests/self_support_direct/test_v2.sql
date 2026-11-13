-- v2: partner -> agent landlord float -> agent withdraws -> merchant pays -> portfolio active (same day).
SET client_min_messages = warning;
TRUNCATE tt.result;
UPDATE public.pipeline_switches SET is_on = true WHERE key = 'self_support_activate_on_landlord_paid';

CALL tt.run('V01', 'Support: rent on the agent landlord float, no Partner Ops, portfolio waits for the landlord', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); rr uuid := tt.plan(500000); r jsonb; v_agent uuid;
        s public.self_support_landlord_payments;
BEGIN
  PERFORM tt.float(pa, 2000000);
  SELECT agent_id INTO v_agent FROM rent_requests WHERE id = rr;
  PERFORM tt.as_user(pa); r := funder_support_tenant_direct(ARRAY[rr]);
  ASSERT r->>'status' = 'awaiting_landlord_payment' AND (r->>'landlord_float_released')::boolean
     AND (r->>'activates_when_landlord_paid')::boolean AND NOT (r->>'awaiting_ops_approval')::boolean, 'result ' || r;
  ASSERT tt.avail(pa) = 2000000 - 510000, 'partner debited once ' || tt.avail(pa);
  ASSERT EXISTS (SELECT 1 FROM agent_landlord_float_allocations WHERE rent_request_id = rr AND agent_id = v_agent
                   AND allocated_amount = 500000 AND status = 'open'), 'allocation on the agent';
  ASSERT tt.agent_float(v_agent) = 500000, 'agent float ' || tt.agent_float(v_agent);
  ASSERT (SELECT status FROM funder_pending_portfolios WHERE portfolio_id = (r->>'portfolio_id')::uuid) = 'approved', 'no Partner Ops';
  ASSERT (SELECT status FROM investor_portfolios WHERE id = (r->>'portfolio_id')::uuid) = 'awaiting_landlord_payment', 'portfolio waits';
  ASSERT (SELECT status FROM partner_self_commitments WHERE id = (r->>'commitment_id')::uuid) = 'awaiting_landlord', 'commitment waits';
  ASSERT (SELECT status = 'idle' AND live_at IS NULL FROM partner_self_funding_lines WHERE rent_request_id = rr), 'line not earning';
  ASSERT (SELECT payout_anchor_at IS NULL FROM partner_self_commitments WHERE id = (r->>'commitment_id')::uuid), 'not anchored';
  s := tt.payment(rr);
  ASSERT s.status = 'queued' AND s.amount = 500000 AND s.landlord_payout_id IS NULL
     AND s.expires_at BETWEEN now() + interval '47 hours' AND now() + interval '49 hours', 'tracking ' || row_to_json(s);
  ASSERT EXISTS (SELECT 1 FROM partner_float_agent_notices WHERE agent_id = v_agent AND rent_request_ids @> ARRAY[rr]), 'agent informed (existing notice)';
  ASSERT (SELECT status FROM rent_requests WHERE id = rr) = 'funded', 'plan funded as today';
  ASSERT NOT EXISTS (SELECT 1 FROM landlord_payouts WHERE rent_request_id = rr), 'no payout until the agent withdraws';
END $t$);

CALL tt.run('V02', 'Agent withdraws, merchant pays: portfolio active, Rent Profit Share from today, 1% + 5,000 paid', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); rr uuid := tt.plan(800000); r jsonb; v_agent uuid; lp uuid;
        s public.self_support_landlord_payments; v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date; l record; c record;
BEGIN
  PERFORM tt.float(pa, 1000000);
  SELECT agent_id INTO v_agent FROM rent_requests WHERE id = rr;
  PERFORM tt.as_user(pa); r := funder_support_tenant_direct(ARRAY[rr]);
  lp := tt.agent_withdraws(rr);
  ASSERT (tt.payment(rr)).status = 'queued', 'still waiting while the merchant has not paid';
  PERFORM tt.merchant_settles(lp);
  s := tt.payment(rr);
  ASSERT s.status = 'paid' AND s.earning_from = v_today AND s.landlord_payout_id = lp, 'paid ' || row_to_json(s);
  SELECT * INTO l FROM partner_self_funding_lines WHERE rent_request_id = rr;
  ASSERT l.status = 'active' AND l.live_at > now() - interval '1 minute' AND l.live_at <= now(), 'live today ' || l.live_at;
  SELECT * INTO c FROM partner_self_commitments WHERE id = l.commitment_id;
  ASSERT c.status = 'active' AND c.payout_anchor_at = l.live_at, 'commitment anchored today';
  ASSERT (SELECT status = 'active' AND next_roi_date = v_today + 30 FROM investor_portfolios WHERE id = (r->>'portfolio_id')::uuid), 'portfolio active';
  ASSERT EXISTS (SELECT 1 FROM general_ledger WHERE source_table = 'landlord_payouts' AND source_id = lp AND category = 'agent_commission_earned'),
    '1% commission paid';
  ASSERT tt.agent_float(v_agent) = 0, 'agent float spent ' || tt.agent_float(v_agent);
  ASSERT (SELECT status FROM rent_requests WHERE id = rr) = 'repaying', 'repaying';
  ASSERT (SELECT count(*) FROM self_support_notices WHERE ref_id = s.id AND event = 'paid' AND audience = 'partner') = 2, 'partner SMS + email';
  ASSERT (SELECT message FROM self_support_notices WHERE ref_id = s.id AND event = 'paid' AND channel = 'sms') LIKE '%Rent Profit Share starts today%', 'wording';
  UPDATE landlord_payouts SET status = 'completed' WHERE id = lp;
  ASSERT (SELECT count(*) FROM self_support_notices WHERE ref_id = s.id AND event = 'paid') = 2, 'once';
END $t$);

CALL tt.run('V03', 'Freeze: the agent payout for a waiting partner plan gets through; a normal one does not; night block untouched', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); rr uuid := tt.plan(300000); lp uuid; v_wr record;
BEGIN
  PERFORM tt.float(pa, 1000000);
  PERFORM tt.as_user(pa); PERFORM funder_support_tenant_direct(ARRAY[rr]);
  lp := tt.agent_withdraws(rr);
  SELECT * INTO v_wr FROM withdrawal_requests WHERE landlord_payout_id = lp;
  ASSERT v_wr.landlord_block_exempt_at IS NOT NULL, 'partner plan let through the freeze';
  ASSERT NOT public.landlord_payout_queue_blocked(lp, v_wr.landlord_block_exempt_at), 'visible to merchants';
  ASSERT (SELECT prosrc LIKE '%v_kampala_hour < 6 OR v_kampala_hour >= 22%' AND prosrc NOT LIKE '%_ssd_%'
            FROM pg_proc WHERE proname = 'enforce_landlord_payout_eligibility'), 'eligibility is the production original';
END $t$);

CALL tt.run('V04', '48 hours, agent never withdrew: recalled from the agent, partner refunded, plan back on the board', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); rr uuid := tt.plan(400000); r jsonb; x jsonb; v_agent uuid;
        s public.self_support_landlord_payments;
BEGIN
  PERFORM tt.float(pa, 1000000);
  SELECT agent_id INTO v_agent FROM rent_requests WHERE id = rr;
  PERFORM tt.as_user(pa); r := funder_support_tenant_direct(ARRAY[rr]);
  PERFORM tt.as_user(NULL);
  UPDATE self_support_landlord_payments SET expires_at = now() - interval '1 minute' WHERE rent_request_id = rr;
  x := ssd_expire_unpaid();
  s := tt.payment(rr);
  ASSERT (x->>'recalled')::int = 1 AND s.status = 'refunded', 'recalled ' || x;
  ASSERT tt.avail(pa) = 1000000, 'partner refunded ' || tt.avail(pa);
  ASSERT tt.agent_float(v_agent) = 0, 'float back off the agent ' || tt.agent_float(v_agent);
  ASSERT NOT EXISTS (SELECT 1 FROM agent_landlord_float_allocations WHERE rent_request_id = rr AND status IN ('open', 'partially_paid')), 'allocation closed';
  ASSERT EXISTS (SELECT 1 FROM v_partner_self_fundable_plans WHERE rent_request_id = rr), 'back on the board';
  ASSERT (SELECT status FROM investor_portfolios WHERE id = (r->>'portfolio_id')::uuid) = 'cancelled', 'portfolio cancelled';
  ASSERT (SELECT message FROM self_support_notices WHERE ref_id = s.id AND audience = 'agent') LIKE '%Do NOT pay the landlord%', 'agent told';
  ASSERT (SELECT count(*) FROM self_support_notices WHERE ref_id = s.id AND audience = 'partner' AND event = 'refunded') = 2, 'partner told';
  -- the same partner can support it again
  PERFORM tt.as_user(pa); r := funder_support_tenant_direct(ARRAY[rr]);
  ASSERT (tt.payment(rr)).status = 'queued', 'second support works';
END $t$);

CALL tt.run('V05', '48 hours but the agent payout is in flight: held for Financial Ops, not recalled', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); fo uuid := tt.person('Fin Ops', ARRAY['financial_ops']);
        rr uuid := tt.plan(400000); x jsonb; lp uuid; e text; j jsonb; row jsonb;
BEGIN
  PERFORM tt.float(pa, 1000000);
  PERFORM tt.as_user(pa); PERFORM funder_support_tenant_direct(ARRAY[rr]);
  lp := tt.agent_withdraws(rr);
  PERFORM tt.as_user(NULL);
  UPDATE self_support_landlord_payments SET expires_at = now() - interval '1 minute' WHERE rent_request_id = rr;
  x := ssd_expire_unpaid();
  ASSERT (x->>'held')::int = 1 AND (tt.payment(rr)).status = 'queued' AND (tt.payment(rr)).stuck_flagged_at IS NOT NULL, 'held ' || x;
  ASSERT tt.avail(pa) = 1000000 - 408000, 'not refunded';
  PERFORM tt.as_user(fo);
  SELECT e2 INTO row FROM jsonb_array_elements(self_support_staff_landlord_payments()) e2 WHERE (e2->>'rent_request_id')::uuid = rr;
  ASSERT row IS NOT NULL AND NOT (row->>'can_refund')::boolean AND row->>'payout_status' = 'pending_merchant_payout', 'staff row ' || row;
  e := tt.err(format('select self_support_staff_resolve(%L::uuid, %L, %L)', (tt.payment(rr)).id, 'refund', 'merchant never paid this'));
  ASSERT e LIKE 'Cannot recall%', e;
  -- Financial Ops fails the agent payout, then the recall goes through
  PERFORM tt.as_user(NULL);
  UPDATE landlord_payouts SET status = 'failed', last_error = 'FinOps rejected' WHERE id = lp;
  PERFORM tt.as_user(fo);
  j := self_support_staff_resolve((tt.payment(rr)).id, 'refund', 'merchant never paid this');
  ASSERT j->>'status' = 'refunded' AND tt.avail(pa) = 1000000, 'refunded after the payout failed ' || j;
END $t$);

CALL tt.run('V06', 'Co-support Rent Plan: one allocation for the full rent; both halves wait; paid activates both', $t$
DECLARE lead uuid := tt.person('Benjamin Lead', ARRAY['supporter']); inv uuid := tt.person('Pius Invitee', ARRAY['supporter']);
        rr uuid := tt.plan(1000000); c jsonb; a jsonb; lp uuid;
BEGIN
  PERFORM tt.float(lead, 1000000); PERFORM tt.float(inv, 1000000);
  PERFORM tt.as_user(lead); c := co_support_create(rr);
  PERFORM tt.as_user(inv); a := co_support_accept(c->>'code');
  ASSERT (a->>'ok')::boolean AND (a->>'landlord_float_released')::boolean AND (a->>'activates_when_landlord_paid')::boolean, 'accept ' || a;
  ASSERT (SELECT count(*) FROM agent_landlord_float_allocations WHERE rent_request_id = rr AND allocated_amount = 1000000) = 1, 'one allocation';
  ASSERT (SELECT count(*) FROM partner_self_funding_lines WHERE rent_request_id = rr AND status = 'idle' AND live_at IS NULL) = 2, 'both halves idle';
  ASSERT (SELECT count(*) FROM partner_self_commitments c2 WHERE c2.id IN (SELECT commitment_id FROM partner_self_funding_lines WHERE rent_request_id = rr)
            AND c2.status = 'awaiting_landlord' AND c2.payout_anchor_at IS NULL) = 2, 'both commitments waiting, unanchored';
  ASSERT (SELECT count(*) FROM self_support_landlord_payments WHERE rent_request_id = rr) = 1, 'tracked once';
  lp := tt.agent_withdraws(rr); PERFORM tt.merchant_settles(lp);
  ASSERT (SELECT count(*) FROM partner_self_funding_lines WHERE rent_request_id = rr AND status = 'active') = 2, 'both live';
  ASSERT (SELECT count(*) FROM self_support_notices n WHERE n.ref_id = (tt.payment(rr)).id AND n.audience = 'partner' AND n.channel = 'email') = 2, 'both emailed';
END $t$);

CALL tt.run('V07', 'Co-support recall: each partner gets their own half back', $t$
DECLARE lead uuid := tt.person('Benjamin Lead', ARRAY['supporter']); inv uuid := tt.person('Pius Invitee', ARRAY['supporter']);
        rr uuid := tt.plan(1000000); c jsonb; a jsonb; x jsonb;
BEGIN
  PERFORM tt.float(lead, 1000000); PERFORM tt.float(inv, 1000000);
  PERFORM tt.as_user(lead); c := co_support_create(rr);
  PERFORM tt.as_user(inv); a := co_support_accept(c->>'code');
  PERFORM tt.as_user(NULL);
  UPDATE self_support_landlord_payments SET expires_at = now() - interval '1 minute' WHERE rent_request_id = rr;
  x := ssd_expire_unpaid();
  ASSERT tt.avail(lead) = 1000000 AND tt.avail(inv) = 1000000, 'both back ' || tt.avail(lead) || ' ' || tt.avail(inv);
  ASSERT (SELECT count(*) FROM partner_self_funding_lines WHERE rent_request_id = rr AND status = 'cancelled') = 2, 'both closed';
  ASSERT EXISTS (SELECT 1 FROM v_partner_self_fundable_plans WHERE rent_request_id = rr), 'plan open again';
END $t$);

CALL tt.run('V08', 'Paid after a recall is flagged for Financial Ops', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); rr uuid := tt.plan(300000); lp uuid; v_alloc record;
BEGIN
  PERFORM tt.float(pa, 1000000);
  PERFORM tt.as_user(pa); PERFORM funder_support_tenant_direct(ARRAY[rr]);
  PERFORM tt.as_user(NULL);
  UPDATE self_support_landlord_payments SET expires_at = now() - interval '1 minute' WHERE rent_request_id = rr;
  PERFORM ssd_expire_unpaid();
  -- a payout row that slipped past (simulated: inserted with triggers off), then paid
  SELECT agent_id, landlord_id INTO v_alloc FROM rent_requests WHERE id = rr;
  SET LOCAL session_replication_role = replica;
  INSERT INTO landlord_payouts (agent_id, landlord_id, rent_request_id, amount, landlord_phone, landlord_name, mobile_money_provider, status)
  VALUES (v_alloc.agent_id, v_alloc.landlord_id, rr, 300000, '0772000000', 'L', 'MTN', 'pending_merchant_payout') RETURNING id INTO lp;
  SET LOCAL session_replication_role = origin;
  UPDATE landlord_payouts SET status = 'awaiting_agent_receipt' WHERE id = lp;
  ASSERT (tt.payment(rr)).stuck_flagged_at IS NOT NULL, 'flagged';
  ASSERT EXISTS (SELECT 1 FROM audit_logs WHERE action_type = 'self_support_paid_after_recall'), 'audit';
END $t$);

CALL tt.run('V09', 'Switch OFF: direct release works again (no PORTFOLIO_FIELD_LOCKED), active at once as before', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); rr uuid := tt.plan(300000); r jsonb;
BEGIN
  UPDATE pipeline_switches SET is_on = false WHERE key = 'self_support_activate_on_landlord_paid';
  PERFORM tt.float(pa, 1000000);
  PERFORM tt.as_user(pa); r := funder_support_tenant_direct(ARRAY[rr]);
  PERFORM tt.as_user(NULL);
  UPDATE pipeline_switches SET is_on = true WHERE key = 'self_support_activate_on_landlord_paid';
  ASSERT r->>'status' = 'active' AND (r->>'landlord_float_released')::boolean, 'old behaviour works: ' || r;
  ASSERT NOT EXISTS (SELECT 1 FROM self_support_landlord_payments WHERE rent_request_id = rr), 'not tracked when OFF';
END $t$);

CALL tt.run('V10', 'Grants, roles, leftovers gone', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); e text;
BEGIN
  ASSERT NOT has_function_privilege('authenticated', 'public._ssd_recall(uuid, text)', 'EXECUTE'), 'recall closed';
  ASSERT NOT has_function_privilege('authenticated', 'public._ssd_hold_until_landlord_paid(uuid, uuid)', 'EXECUTE'), 'hold closed';
  ASSERT has_function_privilege('authenticated', 'public.self_support_staff_landlord_payments(text, integer)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.self_support_my_landlord_payments(integer)', 'EXECUTE'), 'read RPCs open';
  ASSERT NOT has_function_privilege('anon', 'public.self_support_staff_landlord_payments(text, integer)', 'EXECUTE'), 'anon';
  PERFORM tt.as_user(pa);
  e := tt.err('select self_support_staff_landlord_payments()');
  ASSERT e LIKE 'only Financial Ops%', e;
  ASSERT NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname IN ('_ssd_queue_plan', '_ssd_queue_commitment', '_ssd_payout_is_direct',
                                                              '_ssd_inserting', '_ssd_refund', 'trg_ssd_landlord_paid_notify')), 'merchant-direct leftovers dropped';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc ~ '_ssd_(payout_is_direct|inserting|wr_insert)'), 'no dangling references';
END $t$);

SELECT id || ' ' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || ' ' || title || COALESCE(' :: ' || detail, '') FROM tt.result ORDER BY id;
