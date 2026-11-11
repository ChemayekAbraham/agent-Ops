-- Co-support Phase 1 functional tests (throwaway local DB). Stops at the first failed ASSERT.
\set ON_ERROR_STOP 1
SET client_min_messages = warning;

CREATE TABLE t_ids (k text PRIMARY KEY, id uuid);
CREATE FUNCTION t(k text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT id FROM t_ids WHERE t_ids.k = t.k $$;
CREATE FUNCTION t_as(k text) RETURNS void LANGUAGE sql AS $$ SELECT set_config('request.jwt.claim.sub', COALESCE(t(k)::text, ''), false) $$;
CREATE FUNCTION t_err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'NO ERROR'; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
CREATE FUNCTION t_float(k text) RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT public.funder_float_available(t(k)) $$;
CREATE FUNCTION t_credit(k text, amt numeric) RETURNS void LANGUAGE sql AS $$
  INSERT INTO general_ledger (amount, direction, category, user_id, source_table, ledger_scope, wallet_bucket)
  VALUES (amt, 'cash_in', 'float_deposit', t(k), 'test', 'wallet', 'float') $$;
CREATE FUNCTION t_plan(k text, rent numeric) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid; l uuid;
BEGIN
  INSERT INTO landlords (name, phone) VALUES ('Landlord ' || k, '0700000' || length(k)) RETURNING id INTO l;
  INSERT INTO rent_requests (tenant_id, agent_id, landlord_id, rent_amount, request_city, house_image_urls)
  VALUES (t('T'), t('G'), l, rent, 'Kampala', ARRAY['https://x/' || k || '.jpg']) RETURNING id INTO v;
  INSERT INTO t_ids VALUES (k, v);
  RETURN v;
END $$;

INSERT INTO t_ids SELECT x, gen_random_uuid() FROM unnest(ARRAY['A','B','C','D','E','N','U','G','T']) x;
INSERT INTO profiles (id, full_name) SELECT id, k || 'name Surname' FROM t_ids;
UPDATE profiles SET full_name = 'Sarah Nakato' WHERE id = t('A');
UPDATE profiles SET full_name = 'Brian Okello' WHERE id = t('B');
UPDATE profiles SET full_name = 'Tenant Tom' WHERE id = t('T');
INSERT INTO t_partners (user_id, signed, rate) VALUES (t('A'), true, 15), (t('B'), true, 15), (t('C'), true, 15),
  (t('D'), true, 20), (t('E'), true, 15), (t('U'), false, 15);
SELECT t_credit('A', 200000), t_credit('B', 200000), t_credit('C', 400000), t_credit('D', 200000), t_credit('E', 100000);
SELECT t_plan('P1', 300000), t_plan('P2', 300000), t_plan('P3', 90000), t_plan('P4', 250001),
       t_plan('P5', 300000), t_plan('P6', 300000), t_plan('P7', 300000);

-- ===== T1 happy path: 300,000 rent, 2% fee on -> 306,000 -> 153,000 each =====
DO $$
DECLARE r jsonb; vc text; v_inv co_support_invites%ROWTYPE; n int; s numeric;
BEGIN
  PERFORM t_as('A');
  r := co_support_create(t('P1'));
  vc := r->>'code';
  ASSERT r->>'status' = 'open', 'T1 status ' || r;
  ASSERT (r->>'your_share')::numeric = 153000 AND (r->>'partner_share')::numeric = 153000, 'T1 shares ' || r;
  ASSERT (r->>'plan_amount')::numeric = 306000, 'T1 plan amount';
  ASSERT (r->>'your_monthly_rent_profit_share')::numeric = 22950, 'T1 A rent profit share ' || r;
  ASSERT length(vc) = 12, 'T1 code';
  ASSERT t_float('A') = 47000, 'T1 A hold: ' || t_float('A');
  ASSERT NOT EXISTS (SELECT 1 FROM v_partner_self_fundable_plans WHERE rent_request_id = t('P1')), 'T1 plan still listed';
  -- replay returns the same invite
  ASSERT (co_support_create(t('P1'))->>'code') = vc, 'T1 replay';
  -- someone else cannot take it
  PERFORM t_as('C');
  ASSERT t_err(format('select co_support_create(%L)', t('P1'))) LIKE 'PLAN_NOT_AVAILABLE%', 'T1 C create';
  ASSERT t_err(format('select funder_support_tenant_direct(ARRAY[%L]::uuid[], NULL, 1)', t('P1'))) <> 'NO ERROR', 'T1 C direct';
  -- previews
  PERFORM t_as('');
  r := co_support_preview(lower(vc));
  ASSERT (r->>'found')::boolean AND r->>'lead_first_name' = 'Sarah' AND r->>'tenant_first_name' = 'Tenant'
     AND (r->>'your_share')::numeric = 153000 AND r->>'code' IS NULL AND NOT (r->>'can_accept')::boolean
     AND (r->>'referrer_id')::uuid = t('A') AND r->>'your_monthly_rent_profit_share' IS NULL, 'T1 anon preview ' || r;
  PERFORM t_as('D');
  r := co_support_preview(vc);
  ASSERT (r->>'can_accept')::boolean AND (r->>'your_monthly_rent_profit_share')::numeric = 30600, 'T1 D preview (20%) ' || r;
  PERFORM t_as('N');
  ASSERT co_support_preview(vc)->>'reason' = 'not_a_partner', 'T1 N preview';
  PERFORM t_as('U');
  ASSERT co_support_preview(vc)->>'reason' = 'agreement_required', 'T1 U preview';
  ASSERT t_err(format('select co_support_accept(%L)', vc)) LIKE 'AGREEMENT_REQUIRED%', 'T1 U accept';
  PERFORM t_as('N');
  ASSERT t_err(format('select co_support_accept(%L)', vc)) LIKE 'NOT_A_PARTNER%', 'T1 N accept';
  PERFORM t_as('A');
  ASSERT t_err(format('select co_support_accept(%L)', vc)) LIKE 'OWN_INVITE%', 'T1 own accept';
  ASSERT co_support_preview(vc)->>'code' = vc, 'T1 lead sees code';

  -- B accepts
  PERFORM t_as('B');
  r := co_support_accept(vc);
  ASSERT (r->>'ok')::boolean AND r->>'status' = 'completed' AND r->>'your_role' = 'invitee', 'T1 accept ' || r;
  ASSERT (r->>'your_monthly_rent_profit_share')::numeric = 22950, 'T1 B rent profit share';
  SELECT * INTO v_inv FROM co_support_invites WHERE co_support_invites.code = (r->>'code') OR id = (r->>'id')::uuid;
  -- money
  ASSERT get_user_float_available_balance(t('A')) = 47000 AND get_user_float_available_balance(t('B')) = 47000, 'T1 wallets';
  ASSERT t_float('A') = 47000, 'T1 A hold released';
  SELECT count(*), sum(amount) INTO n, s FROM general_ledger WHERE category = 'supporter_rent_fund' AND ledger_scope = 'wallet'
     AND idempotency_key IN ('psm-commit-' || v_inv.lead_commitment_id, 'psm-commit-' || v_inv.invitee_commitment_id);
  ASSERT n = 2 AND s = 306000, 'T1 debits ' || n || ' ' || s;
  SELECT count(*), sum(amount) INTO n, s FROM general_ledger WHERE category = 'rent_disbursement'
     AND source_id IN (SELECT id FROM partner_self_funding_lines WHERE co_support_id = v_inv.id);
  ASSERT n = 2 AND s = 300000, 'T1 rent legs ' || n || ' ' || s;
  SELECT count(*) INTO n FROM general_ledger WHERE idempotency_key IN ('ssfee-' || v_inv.lead_commitment_id, 'ssfee-' || v_inv.invitee_commitment_id);
  ASSERT n = 2, 'T1 two fee payments';
  SELECT count(*), sum(allocated_amount) INTO n, s FROM agent_landlord_float_allocations WHERE rent_request_id = t('P1');
  ASSERT n = 1 AND s = 300000, 'T1 one allocation for full rent';
  -- portfolios + lines
  ASSERT (SELECT count(*) FROM investor_portfolios WHERE id IN (v_inv.lead_portfolio_id, v_inv.invitee_portfolio_id)
            AND status = 'active' AND investment_amount = 153000) = 2, 'T1 portfolios';
  ASSERT (SELECT count(*) FROM partner_self_funding_lines WHERE co_support_id = v_inv.id AND status = 'active'
            AND principal = 153000 AND rent_amount = 150000 AND proxy_fee = 3000 AND proxy_fee_status = 'paid') = 2, 'T1 lines active';
  ASSERT (SELECT count(*) FROM partner_self_commitments WHERE id IN (v_inv.lead_commitment_id, v_inv.invitee_commitment_id)
            AND status = 'active' AND payout_anchor_at IS NOT NULL) = 2, 'T1 commitments anchored';
  ASSERT (SELECT status = 'funded' AND funded_at IS NOT NULL AND self_funding_partner_id = t('A') FROM rent_requests WHERE id = t('P1')), 'T1 plan funded';
  ASSERT (SELECT count(*) FROM partner_float_agent_notices WHERE amount = 300000 AND rent_request_ids = ARRAY[t('P1')]) = 1, 'T1 agent notice';
  ASSERT (SELECT count(*) FROM partner_float_landlord_notices WHERE amount = 300000 AND rent_request_ids = ARRAY[t('P1')]) = 1, 'T1 landlord notice';
  ASSERT (SELECT count(*) FROM funder_pending_portfolios WHERE status = 'approved' AND commitment_id IN (v_inv.lead_commitment_id, v_inv.invitee_commitment_id)) = 2, 'T1 pending approved';
  -- replay
  ASSERT (co_support_accept(vc)->>'idempotent_replay')::boolean, 'T1 accept replay';
  ASSERT (SELECT count(*) FROM agent_landlord_float_allocations WHERE rent_request_id = t('P1')) = 1, 'T1 replay no double';
  -- my invites
  PERFORM t_as('A');
  r := co_support_my_invites();
  ASSERT jsonb_array_length(r) = 1 AND r->0->>'partner_first_name' = 'Brian' AND r->0->>'status' = 'completed', 'T1 A my invites ' || r;
  RAISE NOTICE 'T1 happy path: ok';
END $$;

-- ===== T2 decline, same-link re-invite, new link =====
DO $$
DECLARE r jsonb; code1 text; code2 text; id1 uuid;
BEGIN
  SELECT t_credit('A', 153000) INTO r;  -- top A up again
  PERFORM t_as('A');
  r := co_support_create(t('P2')); code1 := r->>'code'; id1 := (r->>'id')::uuid;
  PERFORM t_as('C');
  r := co_support_decline(code1);
  ASSERT r->>'status' = 'declined', 'T2 decline ' || r;
  ASSERT t_err(format('select co_support_accept(%L)', code1)) LIKE 'INVITE_DECLINED%', 'T2 accept after decline';
  ASSERT NOT EXISTS (SELECT 1 FROM v_partner_self_fundable_plans WHERE rent_request_id = t('P2')), 'T2 still held after decline';
  PERFORM t_as('A');
  ASSERT (SELECT r2->>'partner_first_name' FROM jsonb_array_elements(co_support_my_invites()) r2 WHERE r2->>'id' = id1::text) = 'Cname', 'T2 lead sees who declined';
  r := co_support_reinvite(id1, false);
  ASSERT r->>'code' = code1 AND r->>'status' = 'open', 'T2 same link ' || r;
  r := co_support_reinvite(id1, true);
  code2 := r->>'code';
  ASSERT code2 <> code1 AND r->>'status' = 'open', 'T2 new link';
  PERFORM t_as('C');
  ASSERT t_err(format('select co_support_accept(%L)', code1)) LIKE 'INVITE_CLOSED%', 'T2 old link dead';
  ASSERT (SELECT count(*) FROM co_support_invites WHERE rent_request_id = t('P2') AND status = 'open') = 1, 'T2 one open';
  ASSERT t_float('A') = 47000, 'T2 A holds one half only: ' || t_float('A');
  -- cancel frees everything
  PERFORM t_as('A');
  r := co_support_cancel((SELECT id FROM co_support_invites WHERE co_support_invites.code = code2));
  ASSERT r->>'status' = 'cancelled', 'T2 cancel';
  ASSERT t_float('A') = 200000, 'T2 hold freed: ' || t_float('A');
  ASSERT EXISTS (SELECT 1 FROM v_partner_self_fundable_plans WHERE rent_request_id = t('P2')), 'T2 plan back on list';
  PERFORM t_as('C');
  ASSERT t_err(format('select co_support_accept(%L)', code2)) LIKE 'INVITE_CLOSED%', 'T2 cancelled link';
  RAISE NOTICE 'T2 decline / re-invite / cancel: ok';
END $$;

-- ===== T3 expiry, then someone else can share it =====
DO $$
DECLARE r jsonb; vc text;
BEGIN
  PERFORM t_as('A');
  r := co_support_create(t('P2')); vc := r->>'code';
  UPDATE co_support_invites SET expires_at = now() - interval '1 minute' WHERE co_support_invites.code = vc;
  ASSERT t_float('A') = 200000, 'T3 expired hold released';
  ASSERT EXISTS (SELECT 1 FROM v_partner_self_fundable_plans WHERE rent_request_id = t('P2')), 'T3 plan back after expiry';
  PERFORM t_as('B');
  ASSERT co_support_preview(vc)->>'status' = 'expired', 'T3 preview expired';
  ASSERT t_err(format('select co_support_accept(%L)', vc)) LIKE 'INVITE_EXPIRED%', 'T3 accept expired';
  PERFORM t_as('C');
  r := co_support_create(t('P2'));
  ASSERT r->>'status' = 'open', 'T3 C shares the expired plan';
  ASSERT (SELECT status FROM co_support_invites WHERE co_support_invites.code = vc) = 'expired', 'T3 old marked expired';
  PERFORM t_as('A');
  ASSERT t_err(format('select co_support_reinvite(%L, false)', (SELECT id FROM co_support_invites WHERE co_support_invites.code = vc))) LIKE 'PLAN_NOT_AVAILABLE%', 'T3 A cannot revive';
  PERFORM t_as('C');
  PERFORM co_support_cancel((r->>'id')::uuid);
  RAISE NOTICE 'T3 expiry: ok';
END $$;

-- ===== T4 lead pays the whole plan alone =====
DO $$
DECLARE r jsonb; id1 uuid; n int; s numeric;
BEGIN
  PERFORM t_credit('C', 0);
  PERFORM t_as('C');   -- C has 400,000
  r := co_support_create(t('P2')); id1 := (r->>'id')::uuid;
  r := co_support_fund_alone(id1);
  ASSERT (r->>'ok')::boolean AND r->>'status' = 'active', 'T4 fund alone ' || r;
  ASSERT (SELECT status FROM co_support_invites WHERE id = id1) = 'funded_alone', 'T4 invite closed';
  SELECT count(*), sum(allocated_amount) INTO n, s FROM agent_landlord_float_allocations WHERE rent_request_id = t('P2');
  ASSERT n = 1 AND s = 300000, 'T4 allocation';
  ASSERT get_user_float_available_balance(t('C')) = 94000, 'T4 C paid 306,000: ' || get_user_float_available_balance(t('C'));
  ASSERT (SELECT count(*) FROM partner_self_funding_lines WHERE rent_request_id = t('P2') AND co_support_id IS NULL AND status = 'active') = 1, 'T4 single line';
  RAISE NOTICE 'T4 fund alone: ok';
END $$;

-- ===== T5 checks: too small, odd amounts with fee off, short float, switch off =====
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t_as('A');
  ASSERT t_err(format('select co_support_create(%L)', t('P3'))) LIKE 'CO_SUPPORT_PLAN_TOO_SMALL%', 'T5 too small';
  UPDATE self_support_fee_policy SET enabled = false;
  r := co_support_create(t('P4'));
  ASSERT (r->>'your_share')::numeric = 125001 AND (r->>'partner_share')::numeric = 125000 AND (r->>'plan_amount')::numeric = 250001, 'T5 odd split ' || r;
  PERFORM co_support_cancel((r->>'id')::uuid);
  UPDATE self_support_fee_policy SET enabled = true;
  -- 250,001 with fee: gross ceil(255001.02/100)*100 = 255,100 -> 127,550 + 127,550
  r := co_support_create(t('P4'));
  ASSERT (r->>'your_share')::numeric = 127550 AND (r->>'partner_share')::numeric = 127550, 'T5 fee split ' || r;
  PERFORM t_as('E');   -- E has 100,000 < 127,550
  ASSERT t_err(format('select co_support_accept(%L)', r->>'code')) LIKE 'PARTNER_FUNDS_SHORT: Your half is UGX 127,550. You have UGX 100,000%', 'T5 E short';
  ASSERT co_support_preview(r->>'code')->>'reason' = 'funds_short', 'T5 E preview short';
  ASSERT (co_support_preview(r->>'code')->>'float_needed')::numeric = 27550, 'T5 float needed';
  PERFORM t_as('A');
  PERFORM co_support_cancel((r->>'id')::uuid);
  ASSERT t_err(format('select co_support_create(%L)', t('P5'))) NOT LIKE 'PARTNER_FUNDS_SHORT%', 'T5 A has 200k';
  PERFORM co_support_cancel((SELECT id FROM co_support_invites WHERE rent_request_id = t('P5') AND status = 'open'));
  UPDATE pipeline_switches SET is_on = false;
  ASSERT t_err(format('select co_support_create(%L)', t('P5'))) LIKE 'CO_SUPPORT_UNAVAILABLE%', 'T5 switch off';
  UPDATE pipeline_switches SET is_on = true;
  RAISE NOTICE 'T5 checks: ok';
END $$;

-- ===== T6 lead spent the half elsewhere -> accept refused, nothing moves =====
DO $$
DECLARE r jsonb; before_b numeric;
BEGIN
  PERFORM t_credit('B', 153000);
  PERFORM t_as('A');
  r := co_support_create(t('P5'));
  -- money leaves A's wallet by a path that ignores the hold
  INSERT INTO general_ledger (amount, direction, category, user_id, source_table, ledger_scope, wallet_bucket)
  VALUES (100000, 'cash_out', 'withdrawal', t('A'), 'test', 'wallet', 'float');
  PERFORM t_as('B');
  before_b := get_user_float_available_balance(t('B'));
  ASSERT t_err(format('select co_support_accept(%L)', r->>'code')) LIKE 'LEAD_FUNDS_SHORT%', 'T6 lead short: ' || t_err(format('select co_support_accept(%L)', r->>'code'));
  ASSERT get_user_float_available_balance(t('B')) = before_b, 'T6 B untouched';
  ASSERT (SELECT status FROM co_support_invites WHERE id = (r->>'id')::uuid) = 'open', 'T6 invite still open';
  ASSERT NOT EXISTS (SELECT 1 FROM partner_self_funding_lines WHERE rent_request_id = t('P5')), 'T6 no lines';
  PERFORM t_credit('A', 100000);
  RAISE NOTICE 'T6 lead short: ok';
END $$;

-- ===== T7 plan taken by another path while the invite is open =====
DO $$
DECLARE r jsonb; before_b numeric;
BEGIN
  PERFORM t_as('A');
  r := co_support_my_invites();
  UPDATE rent_requests SET supporter_id = t('G') WHERE id = t('P5');   -- funded some other way
  PERFORM t_as('B');
  before_b := get_user_float_available_balance(t('B'));
  r := co_support_accept((SELECT co_support_invites.code FROM co_support_invites WHERE rent_request_id = t('P5') AND status = 'open'));
  ASSERT NOT (r->>'ok')::boolean AND r->>'status' = 'plan_unavailable', 'T7 ' || r;
  ASSERT (SELECT status FROM co_support_invites WHERE rent_request_id = t('P5') ORDER BY created_at DESC LIMIT 1) = 'plan_unavailable', 'T7 status';
  ASSERT get_user_float_available_balance(t('B')) = before_b AND t_float('A') = 200000, 'T7 no money moved';
  UPDATE rent_requests SET supporter_id = NULL WHERE id = t('P5');
  RAISE NOTICE 'T7 plan taken: ok';
END $$;

-- ===== T8 the old one-partner path still works, and cannot mix with co-support =====
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t_credit('D', 200000);
  PERFORM t_as('D');
  r := funder_support_tenant_direct(ARRAY[t('P6')], NULL, 1);
  ASSERT r->>'status' = 'active', 'T8 single partner ' || r;
  ASSERT (SELECT count(*) FROM partner_self_funding_lines WHERE rent_request_id = t('P6') AND status = 'active') = 1, 'T8 single line active';
  PERFORM t_as('A');
  ASSERT t_err(format('select co_support_create(%L)', t('P6'))) LIKE 'PLAN_NOT_AVAILABLE%', 'T8 funded plan not shareable';
  -- a stray second line on a solo plan is refused by the trigger
  ASSERT t_err(format($q$insert into partner_self_funding_lines (partner_id, rent_request_id, principal, co_support_id)
      values (%L, %L, 1, (select id from co_support_invites limit 1))$q$, t('A'), t('P6'))) LIKE 'PLAN_ALREADY_FUNDED%', 'T8 mix refused';
  RAISE NOTICE 'T8 single path + no mixing: ok';
END $$;

SELECT 'ALL FUNCTIONAL TESTS PASSED' AS result;
