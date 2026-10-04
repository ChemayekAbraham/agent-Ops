
-- New-user hard cap: users on the platform < 7 days are capped at UGX 50,000/day
-- regardless of wallet balance or KYC level, and any attempt above the cap
-- raises a fraud flag.

CREATE OR REPLACE FUNCTION public.enforce_kyc_withdrawal_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_limits record;
  v_today_amount bigint;
  v_today_count int;
  v_account_age_days numeric;
  v_new_user_cap constant bigint := 50000;
  v_effective_cap bigint;
  v_is_new_user boolean := false;
BEGIN
  IF NEW.user_id IS NULL OR NEW.amount IS NULL OR NEW.amount <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_limits FROM public.get_kyc_effective_limits(NEW.user_id);

  IF v_limits.frozen THEN
    RAISE EXCEPTION 'Account frozen pending review. Contact support.'
      USING ERRCODE = 'check_violation', HINT = 'kyc_frozen';
  END IF;

  -- Account age: prefer auth.users.created_at, fall back to profiles.created_at
  SELECT EXTRACT(EPOCH FROM (now() - COALESCE(u.created_at, p.created_at))) / 86400.0
    INTO v_account_age_days
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE p.id = NEW.user_id;

  v_is_new_user := COALESCE(v_account_age_days, 0) < 7;

  -- New users are hard-capped at 50k/day regardless of KYC level
  v_effective_cap := v_limits.daily_withdrawal_cap_ugx;
  IF v_is_new_user AND v_effective_cap > v_new_user_cap THEN
    v_effective_cap := v_new_user_cap;
  END IF;

  SELECT
    COALESCE(SUM(amount),0)::bigint,
    COUNT(*)::int
  INTO v_today_amount, v_today_count
  FROM public.withdrawal_requests
  WHERE user_id = NEW.user_id
    AND created_at >= date_trunc('day', now())
    AND status NOT IN ('rejected','cancelled','failed');

  IF (v_today_amount + NEW.amount) > v_effective_cap THEN
    -- Flag new-user violations for fraud review
    IF v_is_new_user THEN
      INSERT INTO public.kyc_flags (user_id, reason, severity, status)
      VALUES (
        NEW.user_id,
        format(
          'New user (%.1f days old) attempted withdrawal of UGX %s exceeding new-user cap of UGX %s (today already: UGX %s).',
          v_account_age_days, NEW.amount, v_new_user_cap, v_today_amount
        ),
        3,
        'open'
      );

      INSERT INTO public.kyc_risk_events (user_id, event_type, weight, metadata)
      VALUES (
        NEW.user_id,
        'new_user_over_cap_attempt',
        25,
        jsonb_build_object(
          'account_age_days', v_account_age_days,
          'attempted_amount', NEW.amount,
          'today_amount', v_today_amount,
          'cap', v_new_user_cap
        )
      );

      RAISE EXCEPTION 'New accounts (< 7 days old) are limited to UGX % per day. This attempt has been flagged for review.',
        v_new_user_cap
        USING ERRCODE = 'check_violation', HINT = 'new_user_daily_cap';
    END IF;

    RAISE EXCEPTION 'KYC Level % daily withdrawal cap of UGX % exceeded (today: UGX %, requested: UGX %). Verify identity to raise limits.',
      v_limits.kyc_level, v_effective_cap, v_today_amount, NEW.amount
      USING ERRCODE = 'check_violation', HINT = 'kyc_daily_amount_cap';
  END IF;

  IF (v_today_count + 1) > v_limits.daily_withdrawal_count_cap THEN
    RAISE EXCEPTION 'KYC Level % allows only % withdrawal(s) per day. Verify identity to raise limits.',
      v_limits.kyc_level, v_limits.daily_withdrawal_count_cap
      USING ERRCODE = 'check_violation', HINT = 'kyc_daily_count_cap';
  END IF;

  RETURN NEW;
END $function$;
