
-- 1. Payroll-exempt pool helper
CREATE OR REPLACE FUNCTION public.get_user_payroll_exempt_available(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payroll_credits numeric := 0;
  v_withdrawn numeric := 0;
BEGIN
  IF p_user_id IS NULL THEN RETURN 0; END IF;

  -- Lifetime wallet credits attributable to payroll (wallet cash_in legs
  -- that share a transaction_group with a payroll_expense platform leg)
  SELECT COALESCE(SUM(w.amount), 0) INTO v_payroll_credits
  FROM public.general_ledger w
  WHERE w.user_id = p_user_id
    AND w.ledger_scope = 'wallet'
    AND w.direction = 'cash_in'
    AND EXISTS (
      SELECT 1 FROM public.general_ledger p
      WHERE p.transaction_group_id = w.transaction_group_id
        AND p.category = 'payroll_expense'
    );

  -- Lifetime withdrawals (excluding rejected/cancelled/failed)
  SELECT COALESCE(SUM(amount), 0) INTO v_withdrawn
  FROM public.withdrawal_requests
  WHERE user_id = p_user_id
    AND COALESCE(status,'') NOT IN ('rejected','cancelled','failed');

  RETURN GREATEST(0, v_payroll_credits - v_withdrawn);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_payroll_exempt_available(uuid) TO authenticated, service_role;

-- 2. Withdraw context now exempts payroll pool from KYC caps
CREATE OR REPLACE FUNCTION public.get_withdraw_context(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_wallet jsonb;
  v_kyc RECORD;
  v_today_amount numeric := 0;
  v_today_count integer := 0;
  v_remaining_amount numeric := 0;
  v_remaining_count integer := 0;
  v_paused boolean := false;
  v_block_reason text := NULL;
  v_can_submit boolean := true;
  v_withdrawable numeric := 0;
  v_payroll_exempt numeric := 0;
  v_effective_exempt numeric := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('error','missing_user_id');
  END IF;

  v_wallet := public.get_user_wallet_view(p_user_id);
  v_withdrawable := COALESCE((v_wallet->>'withdrawable')::numeric, 0);

  SELECT * INTO v_kyc FROM public.get_kyc_effective_limits(p_user_id) LIMIT 1;

  SELECT COALESCE(SUM(amount), 0), COUNT(*)
  INTO v_today_amount, v_today_count
  FROM public.withdrawal_requests
  WHERE user_id = p_user_id
    AND created_at >= date_trunc('day', now())
    AND COALESCE(status,'') NOT IN ('rejected','cancelled','failed');

  -- Payroll pool exempt from KYC caps (bounded by current withdrawable)
  v_payroll_exempt := public.get_user_payroll_exempt_available(p_user_id);
  v_effective_exempt := LEAST(v_withdrawable, v_payroll_exempt);

  v_remaining_amount := GREATEST(0, COALESCE(v_kyc.daily_withdrawal_cap_ugx,0) - v_today_amount)
                        + v_effective_exempt;
  v_remaining_count  := GREATEST(0, COALESCE(v_kyc.daily_withdrawal_count_cap,0) - v_today_count);

  SELECT COALESCE(enabled, false) INTO v_paused
  FROM public.treasury_controls
  WHERE control_key = 'withdrawals_paused'
  LIMIT 1;

  IF v_paused THEN
    v_can_submit := false;
    v_block_reason := 'Withdrawals are temporarily paused platform-wide. Try again later.';
  ELSIF COALESCE(v_kyc.frozen, false) THEN
    v_can_submit := false;
    v_block_reason := 'Your account is frozen pending review. Contact support.';
  ELSIF v_withdrawable <= 0 THEN
    v_can_submit := false;
    v_block_reason := 'No withdrawable balance available.';
  ELSIF v_remaining_count <= 0 AND v_effective_exempt <= 0 THEN
    -- Payroll pool waives the daily count cap too
    v_can_submit := false;
    v_block_reason := format(
      'KYC Level %s allows %s withdrawal(s) per day. Verify identity to raise limits.',
      COALESCE(v_kyc.kyc_level,1), COALESCE(v_kyc.daily_withdrawal_count_cap,0)
    );
  ELSIF v_remaining_amount <= 0 THEN
    v_can_submit := false;
    v_block_reason := format(
      'Daily withdrawal cap reached at KYC Level %s. Verify identity to raise limits.',
      COALESCE(v_kyc.kyc_level,1)
    );
  END IF;

  RETURN jsonb_build_object(
    'user_id', p_user_id,
    'wallet', v_wallet,
    'kyc', jsonb_build_object(
      'level', COALESCE(v_kyc.kyc_level,1),
      'frozen', COALESCE(v_kyc.frozen,false),
      'daily_cap_ugx', COALESCE(v_kyc.daily_withdrawal_cap_ugx,0),
      'daily_count_cap', COALESCE(v_kyc.daily_withdrawal_count_cap,0),
      'max_single_transfer_ugx', COALESCE(v_kyc.max_single_transfer_ugx,0)
    ),
    'usage_today', jsonb_build_object(
      'amount', v_today_amount,
      'count', v_today_count,
      'remaining_amount', v_remaining_amount,
      'remaining_count', v_remaining_count
    ),
    'payroll', jsonb_build_object(
      'exempt_available', v_effective_exempt,
      'pool_remaining', v_payroll_exempt
    ),
    'gates', jsonb_build_object(
      'withdrawals_paused', v_paused,
      'frozen', COALESCE(v_kyc.frozen,false),
      'can_submit', v_can_submit,
      'block_reason', v_block_reason
    ),
    'generated_at', now()
  );
END;
$function$;
