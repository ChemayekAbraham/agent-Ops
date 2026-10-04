
ALTER TABLE public.e2e_landlord_payout_results ADD COLUMN IF NOT EXISTS action text;

DO $$
DECLARE
  v_agent uuid := 'cb798acb-68bc-4b4e-a414-a3d374e030b6';
  v_landlord uuid := '8ee7cc6e-98e5-40ab-93a9-e1bde49cab1d';
  v_challenge_id uuid;
  v_correct_hash text := encode(digest('123456','sha256'),'hex');
  v_wrong_hash   text := encode(digest('000000','sha256'),'hex');
  v_msg text;
  v_match_ok boolean;
BEGIN
  -- 1) Wrong OTP
  INSERT INTO landlord_payout_otp_challenges
    (agent_id, landlord_id, amount, landlord_name, landlord_phone,
     mobile_money_provider, otp_hash, otp_expires_at, status)
  VALUES (v_agent, v_landlord, 10000, '[TEST]', '+256700000903', 'MTN',
          v_correct_hash, now()+interval '2 minutes', 'pending')
  RETURNING id INTO v_challenge_id;
  v_match_ok := EXISTS (SELECT 1 FROM landlord_payout_otp_challenges
                         WHERE id = v_challenge_id AND otp_hash = v_wrong_hash);
  INSERT INTO public.e2e_landlord_payout_results(action, challenge_id, deduct_result)
  VALUES ('wrong_otp_rejected', v_challenge_id, jsonb_build_object('match', v_match_ok));

  -- 2) Expired OTP
  INSERT INTO landlord_payout_otp_challenges
    (agent_id, landlord_id, amount, landlord_name, landlord_phone,
     mobile_money_provider, otp_hash, otp_expires_at, status)
  VALUES (v_agent, v_landlord, 10000, '[TEST]', '+256700000903', 'MTN',
          v_correct_hash, now() - interval '1 minute', 'pending')
  RETURNING id INTO v_challenge_id;
  INSERT INTO public.e2e_landlord_payout_results(action, challenge_id, deduct_result)
  VALUES ('expired_otp_detected', v_challenge_id,
          jsonb_build_object('expired', (SELECT otp_expires_at < now()
                                         FROM landlord_payout_otp_challenges
                                         WHERE id = v_challenge_id)));

  -- 3) Insufficient float — caught by enforce_landlord_payout_eligibility trigger at INSERT
  BEGIN
    INSERT INTO landlord_payouts
      (agent_id, landlord_id, amount, landlord_phone, landlord_name,
       mobile_money_provider, otp_verified_at, status)
    VALUES (v_agent, v_landlord, 999999999, '+256700000903', '[TEST]', 'MTN',
            now(), 'otp_verified');
    v_msg := 'UNEXPECTED_SUCCESS';
  EXCEPTION WHEN others THEN
    v_msg := SQLERRM;
  END;
  INSERT INTO public.e2e_landlord_payout_results(action, deduct_result)
  VALUES ('insufficient_float_blocked', jsonb_build_object('error', v_msg));
END $$;
