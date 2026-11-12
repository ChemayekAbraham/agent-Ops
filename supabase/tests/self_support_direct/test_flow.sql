-- Merchant-direct self-support: scenario suite on the production-schema clone.
-- Each scenario builds its own people and plans and records PASS/FAIL; one failure never hides another.
SET client_min_messages = warning;
TRUNCATE tt.result;
UPDATE public.pipeline_switches SET is_on = true WHERE key = 'self_support_merchant_direct';

-- S01 -------------------------------------------------------------------------
CALL tt.run('S01', 'Support queues a merchant payout: partner debited once, nothing live, no agent float', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); rr uuid := tt.plan(500000); r jsonb;
        s public.self_support_landlord_payments; lp record; wr record; v_agent uuid; n int;
BEGIN
  PERFORM tt.float(pa, 2000000);
  SELECT agent_id INTO v_agent FROM rent_requests WHERE id = rr;
  PERFORM tt.as_user(pa); r := funder_support_tenant_direct(ARRAY[rr]);
  ASSERT r->>'status' = 'awaiting_landlord_payment' AND (r->>'merchant_direct')::boolean, 'result ' || r;
  ASSERT (r->>'landlord_float_released')::boolean = false AND (r->>'awaiting_ops_approval')::boolean = false, 'flags';
  ASSERT tt.avail(pa) = 2000000 - 510000, 'avail ' || tt.avail(pa);
  s := tt.payment(rr);
  ASSERT s.status = 'queued' AND s.amount = 500000 AND s.expires_at BETWEEN now() + interval '47 hours' AND now() + interval '49 hours', 'payment';
  SELECT * INTO lp FROM landlord_payouts WHERE id = s.landlord_payout_id;
  ASSERT lp.status = 'pending_merchant_payout' AND lp.amount = 500000 AND lp.agent_id = v_agent
     AND (lp.metadata->>'direct_partner')::boolean, 'payout ' || row_to_json(lp);
  SELECT * INTO wr FROM withdrawal_requests WHERE id = s.withdrawal_request_id;
  ASSERT wr.status = 'pending' AND wr.amount = 500000 AND wr.user_id = v_agent AND wr.landlord_payout_id = lp.id
     AND wr.landlord_block_exempt_at IS NOT NULL AND wr.reason LIKE 'Landlord float payout — %'
     AND wr.mobile_money_number = (SELECT verified_mobile_money_number FROM landlords l JOIN rent_requests x ON x.landlord_id = l.id WHERE x.id = rr),
     'withdrawal ' || row_to_json(wr);
  ASSERT NOT public.landlord_payout_queue_blocked(wr.landlord_payout_id, wr.landlord_block_exempt_at), 'visible despite the freeze';
  ASSERT (SELECT count(*) FROM partner_self_commitments c JOIN partner_self_funding_lines l ON l.commitment_id = c.id
           WHERE l.rent_request_id = rr AND c.status = 'awaiting_landlord' AND l.status = 'idle' AND l.live_at IS NULL
             AND c.payout_anchor_at IS NULL) = 1, 'commitment waiting, line idle';
  ASSERT (SELECT ip.status FROM investor_portfolios ip WHERE ip.id = (r->>'portfolio_id')::uuid) = 'awaiting_landlord_payment', 'portfolio';
  ASSERT (SELECT status FROM funder_pending_portfolios WHERE portfolio_id = (r->>'portfolio_id')::uuid) = 'approved', 'no Partner Ops queue';
  ASSERT NOT EXISTS (SELECT 1 FROM agent_landlord_float_allocations WHERE rent_request_id = rr), 'no allocation';
  ASSERT NOT EXISTS (SELECT 1 FROM general_ledger WHERE idempotency_key LIKE 'psm-float-%' AND reference_id LIKE 'PSF-%'
                       AND source_id IN (SELECT id FROM partner_self_funding_lines WHERE rent_request_id = rr)), 'no float legs yet';
  ASSERT (SELECT status FROM rent_requests WHERE id = rr) = 'coo_approved' AND (SELECT funded_at FROM rent_requests WHERE id = rr) IS NULL, 'plan not funded yet';
  ASSERT public.get_agent_lp_float_available(v_agent) = 0, 'agent float untouched';
  SELECT count(*) INTO n FROM self_support_notices WHERE ref_id = s.id AND event = 'queued';
  ASSERT n = 3, 'notices partner sms+email, agent sms: ' || n;
  ASSERT (SELECT message FROM self_support_notices WHERE ref_id = s.id AND audience = 'agent') LIKE '%You do not handle this money%', 'agent wording';
  ASSERT NOT EXISTS (SELECT 1 FROM funder_release_sms WHERE rent_request_id = rr), 'old release SMS not sent';
  ASSERT (SELECT count(*) FROM pgmq.t_msgs WHERE message->>'idempotency_key' LIKE 'ssd:' || s.id || ':queued:%') = 1, 'one email';
  ASSERT (SELECT count(*) FROM general_ledger WHERE idempotency_key = 'psm-commit-' || (r->>'commitment_id')) = 2, 'one debit group (2 legs)';
END $t$);

-- S02 -------------------------------------------------------------------------
CALL tt.run('S02', 'Merchant pays: active, Rent Profit Share from tomorrow, repaying from tomorrow, receipt, no 1%', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); rr uuid := tt.plan(800000); r jsonb;
        s public.self_support_landlord_payments; v_day date := (now() AT TIME ZONE 'Africa/Kampala')::date + 1; v_agent uuid;
        l record; c record; v_msg text;
BEGIN
  PERFORM tt.float(pa, 1000000);
  SELECT agent_id INTO v_agent FROM rent_requests WHERE id = rr;
  PERFORM tt.as_user(pa); r := funder_support_tenant_direct(ARRAY[rr]);
  PERFORM tt.merchant_pays(rr);
  s := tt.payment(rr);
  ASSERT s.status = 'paid' AND s.earning_from = v_day, 'payment ' || row_to_json(s);
  SELECT * INTO l FROM partner_self_funding_lines WHERE rent_request_id = rr;
  ASSERT l.status = 'active' AND (l.live_at AT TIME ZONE 'UTC')::date = v_day AND (l.live_at AT TIME ZONE 'Africa/Kampala')::date = v_day,
    'line live from tomorrow ' || l.live_at;
  SELECT * INTO c FROM partner_self_commitments WHERE id = l.commitment_id;
  ASSERT c.status = 'active' AND c.payout_anchor_at = l.live_at AND c.next_payout_at = l.live_at + interval '1 month', 'commitment anchors';
  ASSERT (SELECT status = 'active' AND next_roi_date = v_day + 30 FROM investor_portfolios WHERE id = (r->>'portfolio_id')::uuid), 'portfolio';
  ASSERT (SELECT status FROM rent_requests WHERE id = rr) = 'repaying', 'plan repaying: ' || (SELECT status FROM rent_requests WHERE id = rr);
  ASSERT (SELECT repayment_starts_on FROM rent_requests WHERE id = rr) = v_day, 'repayment tomorrow';
  ASSERT (SELECT funded_at::date FROM rent_requests WHERE id = rr) <= now()::date, 'funded_at is now, not tomorrow';
  ASSERT EXISTS (SELECT 1 FROM landlord_payout_receipts WHERE payout_id = s.landlord_payout_id), 'receipt issued';
  ASSERT NOT EXISTS (SELECT 1 FROM general_ledger WHERE source_table = 'landlord_payouts' AND source_id = s.landlord_payout_id
                       AND category = 'agent_commission_earned'), 'no 1% commission';
  ASSERT EXISTS (SELECT 1 FROM general_ledger WHERE idempotency_key = 'psm-float-' || l.id), 'platform rent legs at payment';
  ASSERT EXISTS (SELECT 1 FROM general_ledger WHERE idempotency_key = 'ssfee-' || c.id) OR l.proxy_fee = 0, 'agent care fee settled';
  ASSERT (SELECT balance FROM agent_landlord_float WHERE agent_id = v_agent) IS NULL
      OR (SELECT balance FROM agent_landlord_float WHERE agent_id = v_agent) = 0, 'agent float untouched';
  SELECT message INTO v_msg FROM self_support_notices WHERE ref_id = s.id AND event = 'paid' AND audience = 'agent';
  ASSERT v_msg LIKE '%Receipt WLR-%', 'agent gets the receipt: ' || COALESCE(v_msg, 'none');
  SELECT message INTO v_msg FROM self_support_notices WHERE ref_id = s.id AND event = 'paid' AND audience = 'partner' AND channel = 'sms';
  ASSERT v_msg LIKE '%Rent Profit Share starts on ' || to_char(v_day, 'FMDD Mon YYYY') || '%', 'partner date: ' || COALESCE(v_msg, 'none');
  -- the agent's receipt step (completed) changes nothing again
  UPDATE landlord_payouts SET status = 'completed' WHERE id = s.landlord_payout_id;
  ASSERT (SELECT count(*) FROM self_support_notices WHERE ref_id = s.id AND event = 'paid') = 3, 'paid notices once';
  ASSERT (SELECT count(*) FROM general_ledger WHERE idempotency_key = 'psm-float-' || l.id) = 2, 'legs once';
END $t$);

-- S03 -------------------------------------------------------------------------
CALL tt.run('S03', 'Merchant rejects: partner refunded at once, plan open again, nothing live', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); rr uuid := tt.plan(600000); r jsonb;
        s public.self_support_landlord_payments;
BEGIN
  PERFORM tt.float(pa, 1000000);
  PERFORM tt.as_user(pa); r := funder_support_tenant_direct(ARRAY[rr]);
  ASSERT tt.avail(pa) = 1000000 - 612000, 'debited ' || tt.avail(pa);
  PERFORM tt.merchant_rejects(rr);
  s := tt.payment(rr);
  ASSERT s.status = 'refunded' AND s.refund_reason LIKE 'Merchant rejected%', 'refunded ' || row_to_json(s);
  ASSERT tt.avail(pa) = 1000000, 'float back ' || tt.avail(pa);
  ASSERT (SELECT status FROM partner_self_funding_lines WHERE rent_request_id = rr) = 'cancelled', 'line cancelled';
  ASSERT (SELECT status FROM partner_self_commitments WHERE id = (r->>'commitment_id')::uuid) = 'cancelled', 'commitment cancelled';
  ASSERT (SELECT status FROM investor_portfolios WHERE id = (r->>'portfolio_id')::uuid) = 'cancelled', 'portfolio cancelled';
  ASSERT EXISTS (SELECT 1 FROM v_partner_self_fundable_plans WHERE rent_request_id = rr), 'plan back on the board';
  ASSERT NOT EXISTS (SELECT 1 FROM general_ledger WHERE idempotency_key = 'ssfee-' || (r->>'commitment_id')), 'no fee';
  ASSERT (SELECT count(*) FROM self_support_notices WHERE ref_id = s.id AND event = 'refunded') = 3, 'refund notices';
  -- the plan can be supported again
  PERFORM tt.as_user(pa); r := funder_support_tenant_direct(ARRAY[rr]);
  ASSERT r->>'status' = 'awaiting_landlord_payment' AND (tt.payment(rr)).status = 'queued', 'second support queues again';
END $t$);

-- S04 -------------------------------------------------------------------------
CALL tt.run('S04', '48 hours unpaid and unclaimed: out of the queue, partner refunded', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); rr uuid := tt.plan(400000); r jsonb; x jsonb;
        s public.self_support_landlord_payments;
BEGIN
  PERFORM tt.float(pa, 500000);
  PERFORM tt.as_user(pa); r := funder_support_tenant_direct(ARRAY[rr]);
  PERFORM tt.as_user(NULL);
  UPDATE self_support_landlord_payments SET expires_at = now() - interval '1 minute' WHERE rent_request_id = rr;
  x := ssd_expire_unpaid();
  s := tt.payment(rr);
  ASSERT s.status = 'refunded' AND s.refund_reason LIKE 'SELF_SUPPORT_48H%', 'refunded ' || x;
  ASSERT (SELECT status FROM withdrawal_requests WHERE id = s.withdrawal_request_id) = 'cancelled', 'out of merchant queue';
  ASSERT (SELECT status FROM landlord_payouts WHERE id = s.landlord_payout_id) = 'failed', 'payout failed';
  ASSERT tt.avail(pa) = 500000, 'float back';
  x := ssd_expire_unpaid();
  ASSERT (x->>'refunded')::int = 0, 'second run does nothing';
END $t$);

-- S05 -------------------------------------------------------------------------
CALL tt.run('S05', '48 hours but a merchant claimed it: flagged once, not refunded', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); rr uuid := tt.plan(400000); r jsonb; x jsonb;
        s public.self_support_landlord_payments; v_desk uuid;
BEGIN
  PERFORM tt.float(pa, 500000);
  PERFORM tt.as_user(pa); r := funder_support_tenant_direct(ARRAY[rr]);
  PERFORM tt.as_user(NULL);
  s := tt.payment(rr);
  SET LOCAL session_replication_role = replica;
  INSERT INTO cashout_agents (id, agent_id, assigned_by) VALUES (gen_random_uuid(), tt.person('Merchant M', ARRAY['agent']), pa) RETURNING id INTO v_desk;
  UPDATE withdrawal_requests SET assigned_cashout_agent_id = v_desk WHERE id = s.withdrawal_request_id;
  SET LOCAL session_replication_role = origin;
  UPDATE self_support_landlord_payments SET expires_at = now() - interval '1 minute' WHERE id = s.id;
  x := ssd_expire_unpaid();
  ASSERT (x->>'stuck_flagged')::int = 1 AND (tt.payment(rr)).status = 'queued' AND (tt.payment(rr)).stuck_flagged_at IS NOT NULL, 'flagged ' || x;
  x := ssd_expire_unpaid();
  ASSERT (x->>'stuck_flagged')::int = 0, 'flagged once';
  ASSERT tt.avail(pa) = 500000 - 408000, 'still debited';
END $t$);

-- S06 -------------------------------------------------------------------------
CALL tt.run('S06', 'Replay of the same support: no second debit, no second payout', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); rr uuid := tt.plan(300000); r1 jsonb; r2 jsonb;
BEGIN
  PERFORM tt.float(pa, 1000000);
  PERFORM tt.as_user(pa); r1 := funder_support_tenant_direct(ARRAY[rr]); r2 := funder_support_tenant_direct(ARRAY[rr]);
  ASSERT (r2->>'idempotent_replay')::boolean AND r2->>'status' = 'awaiting_landlord_payment', 'replay ' || r2;
  ASSERT tt.avail(pa) = 1000000 - 306000, 'one debit ' || tt.avail(pa);
  ASSERT (SELECT count(*) FROM self_support_landlord_payments WHERE rent_request_id = rr) = 1, 'one payment';
  ASSERT (SELECT count(*) FROM withdrawal_requests w JOIN landlord_payouts p ON p.id = w.landlord_payout_id WHERE p.rent_request_id = rr) = 1, 'one queue row';
END $t$);

-- S07 -------------------------------------------------------------------------
CALL tt.run('S07', 'Not ready: unverified landlord or restricted agent refuses with nothing taken', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); rr uuid := tt.plan(300000, NULL, false); rr2 uuid := tt.plan(300000);
        e text;
BEGIN
  PERFORM tt.float(pa, 1000000);
  PERFORM tt.as_user(pa);
  e := tt.err(format('select funder_support_tenant_direct(ARRAY[%L::uuid])', rr));
  ASSERT e LIKE 'LANDLORD_NOT_READY%', e;
  PERFORM tt.as_user(NULL);
  UPDATE profiles SET is_frozen = true WHERE id = (SELECT agent_id FROM rent_requests WHERE id = rr2);
  PERFORM tt.as_user(pa);
  e := tt.err(format('select funder_support_tenant_direct(ARRAY[%L::uuid])', rr2));
  ASSERT e LIKE 'PLAN_AGENT_RESTRICTED%', e;
  ASSERT tt.avail(pa) = 1000000, 'nothing taken';
  ASSERT NOT EXISTS (SELECT 1 FROM self_support_landlord_payments WHERE rent_request_id IN (rr, rr2)), 'nothing queued';
END $t$);

-- S08 -------------------------------------------------------------------------
CALL tt.run('S08', 'Co-support Rent Plan: both halves debited, ONE payout for the full rent; paid activates both', $t$
DECLARE lead uuid := tt.person('Benjamin Lead', ARRAY['supporter']); inv uuid := tt.person('Pius Invitee', ARRAY['supporter']);
        rr uuid := tt.plan(1000000); inv_row jsonb; acc jsonb; s public.self_support_landlord_payments;
BEGIN
  PERFORM tt.float(lead, 1000000); PERFORM tt.float(inv, 1000000);
  PERFORM tt.as_user(lead); inv_row := co_support_create(rr);
  PERFORM tt.as_user(inv); acc := co_support_accept(inv_row->>'code');
  ASSERT (acc->>'ok')::boolean AND (acc->>'merchant_direct')::boolean AND NOT (acc->>'landlord_float_released')::boolean, 'accept ' || acc;
  s := tt.payment(rr);
  ASSERT s.amount = 1000000 AND array_length(s.partner_ids, 1) = 2 AND array_length(s.line_ids, 1) = 2, 'one payout ' || row_to_json(s);
  ASSERT (SELECT count(*) FROM landlord_payouts WHERE rent_request_id = rr) = 1, 'one landlord payout';
  ASSERT tt.avail(lead) = 1000000 - 510000 AND tt.avail(inv) = 1000000 - 510000, 'halves ' || tt.avail(lead) || ' ' || tt.avail(inv);
  ASSERT (SELECT count(*) FROM self_support_notices WHERE ref_id = s.id AND audience = 'partner' AND channel = 'sms') = 2, 'both partners told';
  PERFORM tt.merchant_pays(rr);
  ASSERT (SELECT count(*) FROM partner_self_funding_lines WHERE rent_request_id = rr AND status = 'active') = 2, 'both lines live';
  ASSERT (SELECT count(*) FROM partner_self_commitments c WHERE c.id = ANY ((tt.payment(rr)).commitment_ids) AND c.status = 'active') = 2, 'both active';
END $t$);

-- S09 -------------------------------------------------------------------------
CALL tt.run('S09', 'Co-support Rent Plan rejected: both partners refunded their own half', $t$
DECLARE lead uuid := tt.person('Benjamin Lead', ARRAY['supporter']); inv uuid := tt.person('Pius Invitee', ARRAY['supporter']);
        rr uuid := tt.plan(1000000); inv_row jsonb; acc jsonb;
BEGIN
  PERFORM tt.float(lead, 1000000); PERFORM tt.float(inv, 1000000);
  PERFORM tt.as_user(lead); inv_row := co_support_create(rr);
  PERFORM tt.as_user(inv); acc := co_support_accept(inv_row->>'code');
  PERFORM tt.merchant_rejects(rr);
  ASSERT tt.avail(lead) = 1000000 AND tt.avail(inv) = 1000000, 'both back ' || tt.avail(lead) || ' ' || tt.avail(inv);
  ASSERT (SELECT count(*) FROM partner_self_funding_lines WHERE rent_request_id = rr AND status = 'cancelled') = 2, 'both lines cancelled';
  ASSERT EXISTS (SELECT 1 FROM v_partner_self_fundable_plans WHERE rent_request_id = rr), 'plan open again';
END $t$);

-- S10 -------------------------------------------------------------------------
CALL tt.run('S10', 'Finance refund path (refund_agent_float_for_payout) refunds the partner, not the agent', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); rr uuid := tt.plan(300000); r jsonb; x jsonb; v_agent uuid;
BEGIN
  PERFORM tt.float(pa, 1000000);
  SELECT agent_id INTO v_agent FROM rent_requests WHERE id = rr;
  PERFORM tt.as_user(pa); r := funder_support_tenant_direct(ARRAY[rr]);
  PERFORM tt.as_user(NULL);
  x := refund_agent_float_for_payout((tt.payment(rr)).landlord_payout_id, 'SLA_BREACH_AUTO_ESCALATE_BY_CRON');
  ASSERT (x->>'direct_partner')::boolean AND (tt.payment(rr)).status = 'refunded', 'refunded ' || x;
  ASSERT tt.avail(pa) = 1000000, 'partner float back';
  ASSERT COALESCE((SELECT balance FROM agent_landlord_float WHERE agent_id = v_agent), 0) = 0, 'agent float not credited';
END $t$);

-- S11 -------------------------------------------------------------------------
CALL tt.run('S11', 'Exemptions cannot be borrowed: a browser-made withdrawal pointing at a direct payout is still checked', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); rr uuid := tt.plan(300000); r jsonb; lp uuid;
BEGIN
  PERFORM tt.float(pa, 1000000);
  PERFORM tt.as_user(pa); r := funder_support_tenant_direct(ARRAY[rr]);
  lp := (tt.payment(rr)).landlord_payout_id;
  ASSERT public._ssd_payout_is_direct(lp) AND NOT public._ssd_wr_insert_is_direct(lp), 'insert exemption only inside the queue function';
  ASSERT NOT public._ssd_inserting(), 'flag cleared after the queue';
END $t$);

-- S12 -------------------------------------------------------------------------
CALL tt.run('S12', 'Grants and row security', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); other uuid := tt.person('Other Person', ARRAY['supporter']);
        rr uuid := tt.plan(300000); r jsonb; v_agent uuid; n int; j jsonb;
BEGIN
  PERFORM tt.float(pa, 1000000);
  SELECT agent_id INTO v_agent FROM rent_requests WHERE id = rr;
  PERFORM tt.as_user(pa); r := funder_support_tenant_direct(ARRAY[rr]);
  ASSERT NOT has_function_privilege('authenticated', 'public._ssd_queue_plan(uuid)', 'EXECUTE'), 'internal closed';
  ASSERT NOT has_function_privilege('authenticated', 'public._ssd_refund(uuid, text)', 'EXECUTE'), 'refund closed';
  ASSERT NOT has_function_privilege('authenticated', 'public.ssd_expire_unpaid(integer)', 'EXECUTE'), 'cron fn closed';
  ASSERT NOT has_function_privilege('anon', 'public.self_support_my_landlord_payments(integer)', 'EXECUTE'), 'anon closed';
  ASSERT has_function_privilege('authenticated', 'public.self_support_my_landlord_payments(integer)', 'EXECUTE'), 'read rpc open';
  ASSERT has_table_privilege('authenticated', 'public.self_support_landlord_payments', 'SELECT')
     AND NOT has_table_privilege('authenticated', 'public.self_support_landlord_payments', 'INSERT')
     AND NOT has_table_privilege('authenticated', 'public.self_support_notices', 'SELECT')
     AND NOT has_table_privilege('anon', 'public.self_support_landlord_payments', 'SELECT'), 'table grants';
  j := self_support_my_landlord_payments();
  ASSERT jsonb_array_length(j) = 1 AND j->0->>'role' = 'partner' AND (j->0->>'my_share')::numeric = 306000, 'partner view ' || j;
  PERFORM tt.as_user(v_agent); j := self_support_my_landlord_payments();
  ASSERT jsonb_array_length(j) = 1 AND j->0->>'role' = 'agent', 'agent view';
  PERFORM tt.as_user(other); j := self_support_my_landlord_payments();
  ASSERT jsonb_array_length(j) = 0, 'stranger sees nothing';
  -- RLS as the authenticated role
  PERFORM tt.as_user(other);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.self_support_landlord_payments;
  RESET ROLE;
  ASSERT n = 0, 'RLS hides other payments: ' || n;
  PERFORM tt.as_user(v_agent);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.self_support_landlord_payments WHERE rent_request_id = rr;
  RESET ROLE;
  ASSERT n = 1, 'agent reads own: ' || n;
END $t$);

-- S13 -------------------------------------------------------------------------
CALL tt.run('S13', 'Normal agent landlord payouts unchanged: float checks, 1% commission', $t$
DECLARE rr uuid := tt.plan(200000); v_agent uuid; v_ld uuid; v_phone text; e text; lp uuid;
BEGIN
  SELECT agent_id, landlord_id INTO v_agent, v_ld FROM rent_requests WHERE id = rr;
  SELECT verified_mobile_money_number INTO v_phone FROM landlords WHERE id = v_ld;
  e := tt.err(format($q$insert into landlord_payouts (agent_id, landlord_id, rent_request_id, amount, landlord_phone, landlord_name, mobile_money_provider)
                         values (%L, %L, %L, 200000, %L, 'L', 'MTN')$q$, v_agent, v_ld, rr, v_phone));
  ASSERT e LIKE '%landlord float%' OR e LIKE '%06:00 and 22:00%', 'agent payout still needs float: ' || e;
  SET LOCAL session_replication_role = replica;
  INSERT INTO agent_landlord_float (agent_id, balance) VALUES (v_agent, 500000);
  SET LOCAL session_replication_role = origin;
  INSERT INTO landlord_payouts (agent_id, landlord_id, rent_request_id, amount, landlord_phone, landlord_name, mobile_money_provider)
  VALUES (v_agent, v_ld, rr, 200000, v_phone, 'L', 'MTN') RETURNING id INTO lp;
  ASSERT NOT public._ssd_payout_is_direct(lp), 'not direct';
  UPDATE landlord_payouts SET status = 'awaiting_agent_receipt', disbursed_at = now() WHERE id = lp;
  ASSERT EXISTS (SELECT 1 FROM general_ledger WHERE source_table = 'landlord_payouts' AND source_id = lp
                   AND category = 'agent_commission_earned'), '1% still paid on agent payouts';
END $t$);

-- S14 -------------------------------------------------------------------------
CALL tt.run('S14', 'Switch OFF: support takes the old path (shows today''s production behaviour)', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); rr uuid := tt.plan(300000); e text;
BEGIN
  UPDATE pipeline_switches SET is_on = false WHERE key = 'self_support_merchant_direct';
  PERFORM tt.float(pa, 1000000);
  PERFORM tt.as_user(pa);
  e := tt.err(format('select funder_support_tenant_direct(ARRAY[%L::uuid])', rr));
  PERFORM tt.as_user(NULL);
  UPDATE pipeline_switches SET is_on = true WHERE key = 'self_support_merchant_direct';
  ASSERT NOT EXISTS (SELECT 1 FROM self_support_landlord_payments WHERE rent_request_id = rr), 'nothing queued when OFF';
  RAISE NOTICE 'S14 switch OFF result: %', e;
  INSERT INTO tt.result VALUES ('S14-info', 'switch OFF outcome (informational)', true, e) ON CONFLICT (id) DO UPDATE SET detail = EXCLUDED.detail;
END $t$);

-- S15 -------------------------------------------------------------------------
CALL tt.run('S15', 'One support for two plans: two payouts; one paid, one refunded; fee and amount settle', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); a uuid := tt.plan(300000); b uuid := tt.plan(500000); r jsonb; c record;
BEGIN
  PERFORM tt.float(pa, 2000000);
  PERFORM tt.as_user(pa); r := funder_support_tenant_direct(ARRAY[a, b]);
  ASSERT (tt.payment(a)).status = 'queued' AND (tt.payment(b)).status = 'queued', 'two payouts';
  ASSERT tt.avail(pa) = 2000000 - 816000, 'one debit for both ' || tt.avail(pa);
  PERFORM tt.merchant_pays(a);
  SELECT * INTO c FROM partner_self_commitments WHERE id = (r->>'commitment_id')::uuid;
  ASSERT c.status = 'active', 'active after the first landlord is paid';
  ASSERT NOT EXISTS (SELECT 1 FROM general_ledger WHERE idempotency_key = 'ssfee-' || c.id), 'fee waits for the other plan';
  PERFORM tt.merchant_rejects(b);
  ASSERT tt.avail(pa) = 2000000 - 306000, 'b refunded ' || tt.avail(pa);
  SELECT * INTO c FROM partner_self_commitments WHERE id = (r->>'commitment_id')::uuid;
  ASSERT c.status = 'active' AND c.committed_amount = 306000, 'commitment keeps a only: ' || c.committed_amount;
  ASSERT EXISTS (SELECT 1 FROM general_ledger WHERE idempotency_key = 'ssfee-' || c.id), 'fee settled once both resolved';
END $t$);

-- S16 -------------------------------------------------------------------------
CALL tt.run('S16', 'Every new ledger group balances (platform side) and posts once', $t$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM (
    SELECT idempotency_key, count(*) n FROM general_ledger
     WHERE idempotency_key LIKE 'psm-commit-%' OR idempotency_key LIKE 'psm-float-%' OR idempotency_key LIKE 'ssd-refund-%'
     GROUP BY 1 HAVING count(*) % 2 <> 0
        OR count(*) FILTER (WHERE ledger_scope = 'wallet') NOT IN (0, count(*) / 2)
        OR count(DISTINCT transaction_group_id) <> 1) x;
  ASSERT bad = 0, 'groups not in pairs, or posted twice: ' || bad;
  SELECT count(*) INTO bad FROM (
    SELECT transaction_group_id FROM general_ledger WHERE idempotency_key LIKE 'ssd-refund-%'
     GROUP BY 1 HAVING sum(CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END) <> 0) y;
  ASSERT bad = 0, 'refund groups net to zero';
END $t$);

-- S17 -------------------------------------------------------------------------
CALL tt.run('S17', 'Payout failed while a merchant is settling it: partner NOT refunded, held for Financial Ops', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); rr uuid := tt.plan(300000); r jsonb; s public.self_support_landlord_payments;
BEGIN
  PERFORM tt.float(pa, 1000000);
  PERFORM tt.as_user(pa); r := funder_support_tenant_direct(ARRAY[rr]);
  PERFORM tt.as_user(NULL);
  s := tt.payment(rr);
  UPDATE withdrawal_requests SET status = 'processing' WHERE id = s.withdrawal_request_id;
  UPDATE landlord_payouts SET status = 'failed', last_error = 'FinOps rejected' WHERE id = s.landlord_payout_id;
  ASSERT (tt.payment(rr)).status = 'queued' AND (tt.payment(rr)).stuck_flagged_at IS NOT NULL, 'held, flagged';
  ASSERT tt.avail(pa) = 1000000 - 306000, 'not refunded';
  ASSERT EXISTS (SELECT 1 FROM audit_logs WHERE action_type = 'self_support_refund_held' AND record_id = s.id::text), 'audit';
END $t$);

-- S18 -------------------------------------------------------------------------
CALL tt.run('S18', 'After a reject refund the queue row is closed: no merchant can settle it later', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); rr uuid := tt.plan(300000); r jsonb; e text;
BEGIN
  PERFORM tt.float(pa, 1000000);
  PERFORM tt.as_user(pa); r := funder_support_tenant_direct(ARRAY[rr]);
  PERFORM tt.as_user(NULL);
  UPDATE landlord_payouts SET status = 'failed', last_error = 'Merchant rejected: x' WHERE id = (tt.payment(rr)).landlord_payout_id;
  ASSERT (SELECT status FROM withdrawal_requests WHERE id = (tt.payment(rr)).withdrawal_request_id) = 'cancelled', 'closed';
  e := tt.err(format('select tt.merchant_pays(%L::uuid)', rr));
  ASSERT e LIKE 'NOT_PAYABLE%', e;
  -- the edge function then marks it rejected: allowed from cancelled
  UPDATE withdrawal_requests SET status = 'rejected', rejection_reason = 'x' WHERE id = (tt.payment(rr)).withdrawal_request_id;
END $t$);

-- S19 -------------------------------------------------------------------------
CALL tt.run('S19', 'Financial Ops resolves a held payment both ways; others cannot', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); fo uuid := tt.person('Fin Ops', ARRAY['financial_ops']);
        rr1 uuid := tt.plan(300000); rr2 uuid := tt.plan(300000); r jsonb; s public.self_support_landlord_payments; e text;
BEGIN
  PERFORM tt.float(pa, 1000000);
  PERFORM tt.as_user(pa); r := funder_support_tenant_direct(ARRAY[rr1]); r := funder_support_tenant_direct(ARRAY[rr2]);
  PERFORM tt.as_user(NULL);
  -- both held: payout failed while the merchant was settling
  UPDATE withdrawal_requests SET status = 'processing' WHERE id IN ((tt.payment(rr1)).withdrawal_request_id, (tt.payment(rr2)).withdrawal_request_id);
  UPDATE landlord_payouts SET status = 'failed', last_error = 'x' WHERE id IN ((tt.payment(rr1)).landlord_payout_id, (tt.payment(rr2)).landlord_payout_id);
  ASSERT (tt.payment(rr1)).status = 'queued' AND (tt.payment(rr2)).status = 'queued', 'held';
  PERFORM tt.as_user(pa);
  e := tt.err(format('select self_support_staff_resolve(%L::uuid, %L, %L)', (tt.payment(rr1)).id, 'refund', 'merchant did not pay this one'));
  ASSERT e LIKE 'only Financial Ops%', 'partner refused: ' || e;
  PERFORM tt.as_user(fo);
  -- rr1: the merchant did not pay
  r := self_support_staff_resolve((tt.payment(rr1)).id, 'refund', 'merchant confirmed nothing was sent');
  ASSERT r->>'status' = 'refunded', 'refund ' || r;
  -- rr2: the merchant did pay
  UPDATE withdrawal_requests SET status = 'completed', processed_at = now() WHERE id = (tt.payment(rr2)).withdrawal_request_id;
  r := self_support_staff_resolve((tt.payment(rr2)).id, 'paid', 'merchant showed the MoMo message');
  ASSERT r->>'status' = 'paid', 'paid ' || r;
  ASSERT (SELECT status FROM partner_self_funding_lines WHERE rent_request_id = rr2) = 'active', 'rr2 live';
  ASSERT tt.avail(pa) = 1000000 - 306000, 'one refunded, one paid: ' || tt.avail(pa);
  e := tt.err(format('select self_support_staff_resolve(%L::uuid, %L, %L)', (tt.payment(rr2)).id, 'refund', 'try to refund a paid one'));
  ASSERT e = 'NO ERROR', 'paid one is a no-op: ' || e;
  ASSERT (tt.payment(rr2)).status = 'paid', 'still paid';
END $t$);

SELECT id || ' ' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || ' ' || title || COALESCE(' :: ' || detail, '') FROM tt.result ORDER BY id;
