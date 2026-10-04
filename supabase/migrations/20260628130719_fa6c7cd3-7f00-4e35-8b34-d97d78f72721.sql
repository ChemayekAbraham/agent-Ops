CREATE OR REPLACE FUNCTION public.verify_payout_code_throttled(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_code text := upper(trim(coalesce(p_code, '')));
  v_window interval := interval '15 minutes';
  v_max_failed int := 8;
  v_failed int;
  v_row payout_codes%ROWTYPE;
  v_profile profiles%ROWTYPE;
  v_preferred uuid;
  v_authorized boolean;
  v_is_staff boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  IF length(v_code) = 0 THEN
    RETURN jsonb_build_object('error', 'empty_code');
  END IF;

  -- Brute-force gate: count this merchant's recent failed code entries
  -- (wrong codes + prior lockouts) across all payouts in the window.
  SELECT count(*) INTO v_failed
  FROM payout_code_audit_log
  WHERE approver_id = v_uid
    AND outcome IN ('mismatch', 'rate_limited')
    AND created_at > now() - v_window;

  IF v_failed >= v_max_failed THEN
    INSERT INTO payout_code_audit_log (
      code_entered, outcome, status_result, approver_id, error_code, error_message
    ) VALUES (
      v_code, 'rate_limited', 'rejected', v_uid, 'CASH_CODE_RATE_LIMITED',
      'Too many failed verify attempts in window'
    );
    RETURN jsonb_build_object(
      'error', 'rate_limited',
      'retry_after', 900,
      'message', 'Too many incorrect codes entered. Please wait about 15 minutes before trying again.'
    );
  END IF;

  v_is_staff := has_role(v_uid, 'manager') OR has_role(v_uid, 'super_admin')
    OR has_role(v_uid, 'cfo') OR has_role(v_uid, 'coo') OR has_role(v_uid, 'operations');

  -- Look up the code (definer bypasses RLS; we re-check authorization below).
  SELECT * INTO v_row
  FROM payout_codes
  WHERE code = v_code
    AND status = 'pending'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_row.id IS NULL THEN
    INSERT INTO payout_code_audit_log (
      code_entered, outcome, status_result, approver_id, error_code, error_message
    ) VALUES (
      v_code, 'mismatch', 'rejected', v_uid, 'CASH_CODE_MISMATCH',
      'No pending payout code matches the entered code'
    );
    RETURN jsonb_build_object('error', 'invalid', 'message', 'Invalid or already-used payout code');
  END IF;

  -- Authorization: staff, or the agent assigned to this withdrawal.
  IF v_is_staff THEN
    v_authorized := true;
  ELSE
    SELECT EXISTS (
      SELECT 1
      FROM withdrawal_requests wr
      LEFT JOIN cashout_agents ca ON ca.id = wr.assigned_cashout_agent_id
      WHERE wr.id = v_row.withdrawal_request_id
        AND (wr.agent_id = v_uid OR ca.agent_id = v_uid)
    ) INTO v_authorized;
  END IF;

  IF NOT v_authorized THEN
    -- Treat as a failed guess so it counts toward the lockout and never reveals data.
    INSERT INTO payout_code_audit_log (
      withdrawal_request_id, payout_code_id, code_entered, outcome, status_result,
      approver_id, error_code, error_message
    ) VALUES (
      v_row.withdrawal_request_id, v_row.id, v_code, 'mismatch', 'rejected',
      v_uid, 'CASH_CODE_NOT_ASSIGNED', 'Merchant not assigned to this payout'
    );
    RETURN jsonb_build_object('error', 'invalid', 'message', 'Invalid or already-used payout code');
  END IF;

  IF v_row.expires_at IS NOT NULL AND v_row.expires_at < now() THEN
    INSERT INTO payout_code_audit_log (
      withdrawal_request_id, payout_code_id, code_entered, outcome, status_result,
      approver_id, error_code, error_message
    ) VALUES (
      v_row.withdrawal_request_id, v_row.id, v_code, 'expired', 'rejected',
      v_uid, 'CASH_CODE_EXPIRED', 'Code TTL elapsed at verify'
    );
    RETURN jsonb_build_object('error', 'expired', 'message', 'This payout code has expired');
  END IF;

  SELECT preferred_cashout_agent_id INTO v_preferred
  FROM withdrawal_requests WHERE id = v_row.withdrawal_request_id;

  SELECT * INTO v_profile FROM profiles WHERE id = v_row.user_id;

  -- Success — record a verified attempt.
  INSERT INTO payout_code_audit_log (
    withdrawal_request_id, payout_code_id, code_entered, code_on_file, outcome,
    status_result, approver_id, request_owner_id, amount
  ) VALUES (
    v_row.withdrawal_request_id, v_row.id, v_code, v_row.code, 'verified',
    'verified', v_uid, v_row.user_id, v_row.amount
  );

  RETURN jsonb_build_object(
    'id', v_row.id,
    'withdrawal_request_id', v_row.withdrawal_request_id,
    'user_id', v_row.user_id,
    'code', v_row.code,
    'amount', v_row.amount,
    'status', v_row.status,
    'expires_at', v_row.expires_at,
    'profiles', jsonb_build_object('full_name', v_profile.full_name, 'phone', v_profile.phone),
    '_isPreferred', (v_preferred IS NOT NULL)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_payout_code_throttled(text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.verify_payout_code_throttled(text) FROM anon;