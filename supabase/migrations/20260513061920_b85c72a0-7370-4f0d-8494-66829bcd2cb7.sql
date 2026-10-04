
DO $$
DECLARE
  v_agent uuid := 'cb798acb-68bc-4b4e-a414-a3d374e030b6';
  v_landlord uuid := '8ee7cc6e-98e5-40ab-93a9-e1bde49cab1d';
  v_tenant uuid := '6f2ce166-42dd-44d3-8730-e811c45915f6';
  v_rr uuid := '32bfe147-1c7c-42af-8c3a-d7c88895dd45';
  v_amount numeric := 50000;
  v_otp text := '123456';
  v_otp_hash text := encode(digest('123456','sha256'),'hex');
  v_challenge_id uuid;
  v_payout_id uuid;
  v_pre_float numeric;
  v_post_float numeric;
  v_deduct jsonb;
  v_payout record;
  v_challenge record;
BEGIN
  SELECT balance INTO v_pre_float FROM agent_landlord_float WHERE agent_id = v_agent;

  -- Step 1: issue-landlord-payout-otp equivalent
  INSERT INTO landlord_payout_otp_challenges
    (agent_id, landlord_id, tenant_id, rent_request_id, amount, landlord_name, landlord_phone,
     mobile_money_provider, otp_hash, otp_expires_at, status)
  VALUES
    (v_agent, v_landlord, v_tenant, v_rr, v_amount, '[TEST] Landlord Joshua Demo', '+256700000903',
     'MTN', v_otp_hash, now() + interval '2 minutes', 'pending')
  RETURNING id INTO v_challenge_id;

  -- Step 2: verify-landlord-payout-otp equivalent (correct hash check)
  PERFORM 1 FROM landlord_payout_otp_challenges
    WHERE id = v_challenge_id AND otp_hash = v_otp_hash;
  IF NOT FOUND THEN RAISE EXCEPTION 'OTP hash mismatch'; END IF;
  UPDATE landlord_payout_otp_challenges
    SET status='verified', verified_at = now()
    WHERE id = v_challenge_id;

  -- Step 3: landlord-payout-disburse equivalent — insert payout row
  INSERT INTO landlord_payouts
    (agent_id, landlord_id, tenant_id, rent_request_id, amount, landlord_phone, landlord_name,
     mobile_money_provider, otp_verified_at, status)
  VALUES
    (v_agent, v_landlord, v_tenant, v_rr, v_amount, '+256700000903', '[TEST] Landlord Joshua Demo',
     'MTN', now(), 'otp_verified')
  RETURNING id INTO v_payout_id;

  -- Step 4: deduct float
  v_deduct := public.deduct_agent_float_for_payout(v_payout_id);

  -- Move to pending_finops
  UPDATE landlord_payouts SET status='pending_finops_disbursement' WHERE id = v_payout_id;

  -- Link challenge -> payout
  UPDATE landlord_payout_otp_challenges
    SET resulting_payout_id = v_payout_id WHERE id = v_challenge_id;

  SELECT balance INTO v_post_float FROM agent_landlord_float WHERE agent_id = v_agent;

  -- Capture results
  CREATE TABLE IF NOT EXISTS public.e2e_landlord_payout_results (
    run_at timestamptz DEFAULT now(),
    challenge_id uuid,
    payout_id uuid,
    pre_float numeric,
    post_float numeric,
    deduct_result jsonb,
    final_payout_status text,
    final_challenge_status text
  );

  SELECT * INTO v_payout FROM landlord_payouts WHERE id = v_payout_id;
  SELECT * INTO v_challenge FROM landlord_payout_otp_challenges WHERE id = v_challenge_id;

  INSERT INTO public.e2e_landlord_payout_results
    (challenge_id, payout_id, pre_float, post_float, deduct_result,
     final_payout_status, final_challenge_status)
  VALUES
    (v_challenge_id, v_payout_id, v_pre_float, v_post_float, v_deduct,
     v_payout.status, v_challenge.status);

  RAISE NOTICE 'E2E ok: pre=% post=% deducted=% payout=% challenge=%',
    v_pre_float, v_post_float, v_deduct, v_payout.status, v_challenge.status;
END $$;
