-- Merchant-direct: empty houses are instant (no Partner Ops), earning from tomorrow.
SET client_min_messages = warning;
UPDATE public.pipeline_switches SET is_on = true WHERE key = 'self_support_activate_on_landlord_paid';

CREATE OR REPLACE FUNCTION tt.house(p_rent integer) RETURNS uuid
LANGUAGE plpgsql SET session_replication_role = replica AS $$
DECLARE v uuid := gen_random_uuid(); ag uuid := tt.person('HouseAgent' || nextval('tt.seq'), ARRAY['agent']); l uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.landlords (id, name, phone, verified, verified_mobile_money_number, property_address)
  VALUES (l, 'House Landlord', tt.phone(), true, NULL, 'Kampala');
  INSERT INTO public.house_listings (id, agent_id, landlord_id, title, monthly_rent, region, address, verified, status, is_hidden)
  VALUES (v, ag, l, 'Room', p_rent, 'Central', 'Kampala', true, 'available', false);
  RETURN v;
END $$;

CALL tt.run('H01', 'One partner supports an empty house: active at once, no Partner Ops, earning from tomorrow', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); h uuid := tt.house(300000); r jsonb;
        v_day date := (now() AT TIME ZONE 'Africa/Kampala')::date; ip record;
BEGIN
  PERFORM tt.float(pa, 1000000);
  PERFORM tt.as_user(pa); r := partner_support_houses(ARRAY[h], 1, 'house-' || h::text, NULL::uuid);
  ASSERT r->>'status' = 'active' AND (r->>'earning_from')::date = v_day, 'result ' || r;
  SELECT * INTO ip FROM investor_portfolios WHERE id = (r->>'portfolio_id')::uuid;
  ASSERT ip.status = 'active' AND ip.next_roi_date = (now() AT TIME ZONE 'Africa/Kampala')::date + 30, 'portfolio ' || ip.status || ' ' || ip.next_roi_date;
  ASSERT (SELECT status FROM funder_pending_portfolios WHERE portfolio_id = ip.id) = 'approved', 'not in the Partner Ops queue';
  ASSERT (SELECT status FROM partner_self_commitments WHERE id = (r->>'commitment_id')::uuid) = 'active', 'commitment active';
  ASSERT (SELECT status FROM partner_supported_houses WHERE commitment_id = (r->>'commitment_id')::uuid) = 'active', 'house active';
  ASSERT tt.avail(pa) = 1000000 - 306000, 'debited ' || tt.avail(pa);
  ASSERT NOT EXISTS (SELECT 1 FROM landlord_payouts lp JOIN house_listings hl ON hl.landlord_id = lp.landlord_id WHERE hl.id = h),
    'no landlord payout, no merchant';
  ASSERT NOT EXISTS (SELECT 1 FROM agent_landlord_float_allocations a WHERE a.landlord_id = (SELECT landlord_id FROM house_listings WHERE id = h)),
    'no landlord float';
  ASSERT (SELECT count(*) FROM self_support_notices WHERE ref_id = ip.id AND event = 'house_active') = 2, 'sms + email';
  -- replay
  r := partner_support_houses(ARRAY[h], 1, 'house-' || h::text, NULL::uuid);
  ASSERT (r->>'idempotent_replay')::boolean AND tt.avail(pa) = 1000000 - 306000, 'replay no second debit';
END $t$);

CALL tt.run('H02', 'Three-argument overload carries the same instant branch (it cannot be called unambiguously by name)', $t$
  ASSERT (SELECT prosrc LIKE '%_ssd_house_instant%' FROM pg_proc WHERE proname = 'partner_support_houses' AND pronargs = 3), 'patched';
$t$);

CALL tt.run('H03', 'Co-supported empty house: both halves active at once, no Partner Ops pair approval', $t$
DECLARE lead uuid := tt.person('Benjamin Lead', ARRAY['supporter']); inv uuid := tt.person('Pius Invitee', ARRAY['supporter']);
        h uuid := tt.house(1000000); c jsonb; a jsonb;
BEGIN
  PERFORM tt.float(lead, 1000000); PERFORM tt.float(inv, 1000000);
  PERFORM tt.as_user(lead); c := co_support_create_house(h);
  PERFORM tt.as_user(inv); a := co_support_accept(c->>'code');
  ASSERT (a->>'ok')::boolean AND (a->>'house_active')::boolean AND NOT (a->>'awaiting_partner_ops')::boolean, 'accept ' || a;
  ASSERT tt.avail(lead) = 1000000 - 510000 AND tt.avail(inv) = 1000000 - 510000, 'both debited ' || tt.avail(lead) || ' ' || tt.avail(inv);
  ASSERT (SELECT count(*) FROM investor_portfolios ip JOIN co_support_invites ci ON ip.id IN (ci.lead_portfolio_id, ci.invitee_portfolio_id)
           WHERE ci.code = c->>'code' AND ip.status = 'active') = 2, 'both portfolios active';
END $t$);

CALL tt.run('H04', 'Switch OFF: houses still wait for Partner Ops', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); h uuid := tt.house(200000); r jsonb;
BEGIN
  UPDATE pipeline_switches SET is_on = false WHERE key = 'self_support_activate_on_landlord_paid';
  PERFORM tt.float(pa, 1000000);
  PERFORM tt.as_user(pa); r := partner_support_houses(ARRAY[h], 1, 'houseoff-' || h::text, NULL::uuid);
  PERFORM tt.as_user(NULL);
  UPDATE pipeline_switches SET is_on = true WHERE key = 'self_support_activate_on_landlord_paid';
  ASSERT r->>'status' = 'pending_ops_approval', 'old behaviour ' || r;
END $t$);

SELECT id || ' ' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || ' ' || title || COALESCE(' :: ' || detail, '') FROM tt.result WHERE id LIKE 'H%' ORDER BY id;
