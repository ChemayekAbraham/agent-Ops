-- Test helpers for the merchant-direct rehearsal on the production-schema clone.
-- Fixture rows are inserted with triggers off (replica); everything under test runs with triggers on.
SET client_min_messages = warning;
CREATE SCHEMA IF NOT EXISTS tt;
CREATE TABLE IF NOT EXISTS tt.result (id text PRIMARY KEY, title text, ok boolean, detail text);
CREATE SEQUENCE IF NOT EXISTS tt.seq;

CREATE OR REPLACE FUNCTION tt.as_user(p uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', COALESCE(p::text, ''), false),
         set_config('request.jwt.claim.role', CASE WHEN p IS NULL THEN '' ELSE 'authenticated' END, false) $$;

CREATE OR REPLACE FUNCTION tt.phone() RETURNS text LANGUAGE sql AS
$$ SELECT '0772' || lpad((nextval('tt.seq') % 1000000)::text, 6, '0') $$;

CREATE OR REPLACE FUNCTION tt.person(p_name text, p_roles text[] DEFAULT '{}', p_phone text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SET session_replication_role = replica AS $$
DECLARE v uuid := gen_random_uuid(); r text; v_phone text := COALESCE(p_phone, tt.phone());
BEGIN
  INSERT INTO auth.users (id, email, phone) VALUES (v, lower(replace(p_name, ' ', '.')) || nextval('tt.seq') || '@test.local', v_phone);
  INSERT INTO public.profiles (id, full_name, phone, email) VALUES (v, p_name, v_phone,
    lower(replace(p_name, ' ', '.')) || nextval('tt.seq') || '@test.local');
  FOREACH r IN ARRAY p_roles LOOP
    INSERT INTO public.user_roles (user_id, role) VALUES (v, r::public.app_role);
  END LOOP;
  IF 'supporter' = ANY (p_roles) THEN
    INSERT INTO public.supporter_agreement_acceptance (supporter_id, status) VALUES (v, 'accepted');
  END IF;
  RETURN v;
END $$;

-- Float for a partner: a real ledger posting (wallet float cash_in), triggers on.
CREATE OR REPLACE FUNCTION tt.float(p uuid, p_amount numeric) RETURNS void LANGUAGE sql AS $$
  SELECT public.create_ledger_transaction(jsonb_build_array(
    jsonb_build_object('user_id', p, 'amount', p_amount, 'direction', 'cash_in', 'category', 'agent_float_deposit',
      'ledger_scope', 'wallet', 'wallet_bucket', 'float', 'recipient_type', 'operational_wallet',
      'source_table', 'tt', 'description', 'test float'),
    jsonb_build_object('amount', p_amount, 'direction', 'cash_out', 'category', 'agent_float_deposit',
      'ledger_scope', 'platform', 'source_table', 'tt', 'description', 'test float')),
    'tt-float-' || gen_random_uuid()::text) $$;

CREATE OR REPLACE FUNCTION tt.avail(p uuid) RETURNS numeric LANGUAGE sql AS $$ SELECT public.funder_float_available(p) $$;

-- A Rent Plan ready for funders: verified landlord with an approved number, assigned agent.
CREATE OR REPLACE FUNCTION tt.plan(p_rent numeric, p_agent uuid DEFAULT NULL, p_landlord_verified boolean DEFAULT true) RETURNS uuid
LANGUAGE plpgsql SET session_replication_role = replica AS $$
DECLARE v uuid := gen_random_uuid(); l uuid := gen_random_uuid(); tn uuid; ag uuid; lphone text := tt.phone();
BEGIN
  tn := tt.person('Tenant' || nextval('tt.seq') || ' Test', ARRAY['tenant']);
  ag := COALESCE(p_agent, tt.person('Agent' || nextval('tt.seq') || ' Test', ARRAY['agent']));
  INSERT INTO public.landlords (id, name, phone, mobile_money_number, verified, verified_mobile_money_number, property_address)
  VALUES (l, 'Landlord ' || nextval('tt.seq'), lphone, lphone, p_landlord_verified, CASE WHEN p_landlord_verified THEN lphone END, 'Kampala');
  INSERT INTO public.rent_requests (id, tenant_id, agent_id, assigned_agent_id, landlord_id, rent_amount, duration_days,
    daily_repayment, total_repayment, number_of_payments, access_fee, request_fee, status, coo_reviewed_at, tenancy_status, funder_visible,
    tenant_ops_reviewed_at, tenant_ops_reviewed_by, request_city, house_image_urls)
  VALUES (v, tn, ag, ag, l, p_rent, 30, round(p_rent * 1.3 / 30), round(p_rent * 1.3), 30, 0, 0, 'coo_approved', now(), 'active', true,
          now(), ag, 'Kampala', ARRAY['https://x/h.jpg']);
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION tt.payment(p_rr uuid) RETURNS public.self_support_landlord_payments LANGUAGE sql AS
$$ SELECT * FROM public.self_support_landlord_payments WHERE rent_request_id = p_rr ORDER BY created_at DESC, (status <> 'refunded') DESC LIMIT 1 $$;

-- The merchant pays: what approve-withdrawal does, minus the HTTP.
CREATE OR REPLACE FUNCTION tt.merchant_pays(p_rr uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s public.self_support_landlord_payments; v_merchant uuid; v_desk uuid;
BEGIN
  s := tt.payment(p_rr);
  PERFORM tt.as_user(NULL);
  PERFORM set_config('request.jwt.claim.role', 'service_role', false);
  PERFORM public.deduct_agent_float_for_payout(s.landlord_payout_id);
  -- approve-withdrawal's atomic claim flip: only a payout still in the queue can be settled
  UPDATE public.withdrawal_requests SET status = 'processing' WHERE id = s.withdrawal_request_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_PAYABLE: withdrawal is no longer pending'; END IF;
  UPDATE public.withdrawal_requests SET status = 'completed', processed_at = now(), transaction_id = 'TID' || nextval('tt.seq')
   WHERE id = s.withdrawal_request_id;
  UPDATE public.landlord_payouts
     SET status = 'awaiting_agent_receipt', finops_disbursed_at = now(), finops_momo_reference = 'MOMO' || nextval('tt.seq'),
         disbursed_at = now()
   WHERE id = s.landlord_payout_id AND status IN ('pending_merchant_payout', 'awaiting_agent_receipt');
  PERFORM set_config('request.jwt.claim.role', '', false);
END $$;

-- The merchant rejects: what reject-withdrawal does.
CREATE OR REPLACE FUNCTION tt.merchant_rejects(p_rr uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s public.self_support_landlord_payments;
BEGIN
  s := tt.payment(p_rr);
  PERFORM tt.as_user(NULL);
  UPDATE public.landlord_payouts SET status = 'failed', last_error = 'Merchant rejected: wrong name on number'
   WHERE id = s.landlord_payout_id AND status IN ('otp_verified', 'pending_merchant_payout', 'pending_finops_disbursement', 'disbursing');
  UPDATE public.withdrawal_requests SET status = 'rejected', rejection_reason = 'wrong name', processed_at = now()
   WHERE id = s.withdrawal_request_id;
END $$;

CREATE OR REPLACE FUNCTION tt.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'NO ERROR'; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;

CREATE OR REPLACE PROCEDURE tt.run(p_id text, p_title text, p_body text) LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    IF p_body ~* '^\s*declare' THEN EXECUTE 'DO $b$ ' || p_body || ' $b$';
    ELSE EXECUTE 'DO $b$ BEGIN ' || p_body || ' END $b$'; END IF;
    INSERT INTO tt.result VALUES (p_id, p_title, true, NULL) ON CONFLICT (id) DO UPDATE SET ok = true, detail = NULL;
  EXCEPTION WHEN OTHERS OR assert_failure THEN
    INSERT INTO tt.result VALUES (p_id, p_title, false, SQLERRM) ON CONFLICT (id) DO UPDATE SET ok = false, detail = EXCLUDED.detail;
  END;
  PERFORM tt.as_user(NULL);
END $$;

-- ---- v2: the agent's own withdrawal (what landlord-payout-disburse does after the landlord OTP) ----
CREATE OR REPLACE FUNCTION tt.agent_withdraws(p_rr uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE a record; v_lp uuid; v_phone text; v_name text;
BEGIN
  SELECT al.agent_id, al.landlord_id, al.tenant_id, al.allocated_amount - COALESCE(al.paid_out_amount, 0) AS amt INTO a
    FROM public.agent_landlord_float_allocations al
   WHERE al.rent_request_id = p_rr AND al.source = 'partner_self_funding' AND al.status IN ('open', 'partially_paid')
   ORDER BY al.created_at DESC LIMIT 1;
  IF a.agent_id IS NULL THEN RAISE EXCEPTION 'no open allocation for %', p_rr; END IF;
  SELECT verified_mobile_money_number, name INTO v_phone, v_name FROM public.landlords WHERE id = a.landlord_id;
  PERFORM tt.as_user(NULL);
  INSERT INTO public.landlord_payouts (agent_id, landlord_id, tenant_id, rent_request_id, amount, landlord_phone, landlord_name,
                                       mobile_money_provider, otp_verified_at, status)
  VALUES (a.agent_id, a.landlord_id, a.tenant_id, p_rr, a.amt, v_phone, v_name, 'MTN', now(), 'otp_verified')
  RETURNING id INTO v_lp;
  INSERT INTO public.withdrawal_requests (user_id, amount, status, payout_method, mobile_money_provider, mobile_money_number,
                                         mobile_money_name, reason, landlord_payout_id)
  VALUES (a.agent_id, a.amt, 'pending', 'mobile_money', 'mtn', v_phone, v_name,
          'Landlord float payout — ' || v_name || ' (' || v_phone || ')', v_lp);
  UPDATE public.landlord_payouts SET status = 'pending_merchant_payout' WHERE id = v_lp;
  RETURN v_lp;
END $$;

-- The merchant settles it (approve-withdrawal: claim flip, float debit, completed -> payout paid).
CREATE OR REPLACE FUNCTION tt.merchant_settles(p_lp uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_wr uuid;
BEGIN
  SELECT id INTO v_wr FROM public.withdrawal_requests WHERE landlord_payout_id = p_lp ORDER BY created_at DESC LIMIT 1;
  PERFORM tt.as_user(NULL);
  UPDATE public.withdrawal_requests SET status = 'processing' WHERE id = v_wr AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_PAYABLE: withdrawal is no longer pending'; END IF;
  PERFORM public.deduct_agent_float_for_payout(p_lp);
  UPDATE public.withdrawal_requests SET status = 'completed', processed_at = now(), transaction_id = 'TID' || nextval('tt.seq')
   WHERE id = v_wr;
  UPDATE public.landlord_payouts SET status = 'awaiting_agent_receipt', finops_disbursed_at = now(), disbursed_at = now(),
         finops_momo_reference = 'MOMO' || nextval('tt.seq')
   WHERE id = p_lp AND status IN ('pending_merchant_payout', 'awaiting_agent_receipt');
END $$;

CREATE OR REPLACE FUNCTION tt.agent_float(p_agent uuid) RETURNS numeric LANGUAGE sql AS
$$ SELECT COALESCE((SELECT balance FROM public.agent_landlord_float WHERE agent_id = p_agent), 0) $$;
