-- Remove daily withdrawal limits globally by:
-- 1. Setting KYC config caps to effectively unlimited
-- 2. Replacing the enforcement trigger with a no-op
-- 3. Removing remaining-amount/count gates from get_withdraw_context

-- 1. Open the taps: every KYC level gets effectively unlimited daily withdrawals.
UPDATE public.kyc_level_config
SET
  daily_withdrawal_cap_ugx = 999999999999,
  daily_withdrawal_count_cap = 9999,
  max_single_transfer_ugx = GREATEST(max_single_transfer_ugx, 999999999999),
  updated_at = now();

-- 2. Disable the INSERT trigger that enforces daily caps on withdrawal_requests.
DROP TRIGGER IF EXISTS trg_enforce_kyc_withdrawal_cap ON public.withdrawal_requests;

-- Keep a harmless no-op function attached so any code that references it stays valid.
CREATE OR REPLACE FUNCTION public.enforce_kyc_withdrawal_cap()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN NEW;
END;
$$;

-- 3. Rewrite get_withdraw_context so it no longer gates on remaining daily amount/count.
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
  v_paused boolean := false;
  v_block_reason text := NULL;
  v_can_submit boolean := true;
  v_withdrawable numeric := 0;
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
  END IF;

  RETURN jsonb_build_object(
    'user_id', p_user_id,
    'wallet', v_wallet,
    'kyc', jsonb_build_object(
      'level', COALESCE(v_kyc.kyc_level,1),
      'frozen', COALESCE(v_kyc.frozen,false),
      'daily_cap_ugx', 999999999999,
      'daily_count_cap', 9999,
      'max_single_transfer_ugx', COALESCE(v_kyc.max_single_transfer_ugx,999999999999)
    ),
    'usage_today', jsonb_build_object(
      'amount', v_today_amount,
      'count', v_today_count,
      'remaining_amount', 999999999999,
      'remaining_count', 9999
    ),
    'payroll', jsonb_build_object(
      'exempt_available', 0,
      'pool_remaining', 0
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

GRANT EXECUTE ON FUNCTION public.get_withdraw_context(uuid) TO authenticated, service_role;