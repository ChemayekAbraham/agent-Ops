CREATE OR REPLACE FUNCTION public.enforce_kyc_withdrawal_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_daily_cap constant bigint := 50000;
  v_newuser_window constant interval := interval '30 days';
  v_today_amount bigint;
  v_frozen boolean;
  v_account_age interval;
BEGIN
  IF NEW.user_id IS NULL OR NEW.amount IS NULL OR NEW.amount <= 0 THEN
    RETURN NEW;
  END IF;

  -- Landlord float payouts bypass (float already deducted upstream).
  IF NEW.landlord_payout_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Proxy-agent withdrawals on behalf of a proxy partner bypass the cap.
  IF NEW.proxy_partner_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Frozen accounts remain blocked (all users, regardless of age).
  SELECT COALESCE(frozen, false) INTO v_frozen
  FROM public.get_kyc_effective_limits(NEW.user_id);

  IF v_frozen THEN
    RAISE EXCEPTION 'Account frozen pending review. Contact support.'
      USING ERRCODE = 'check_violation', HINT = 'kyc_frozen';
  END IF;

  -- Determine account age. Only newly-registered users (<= 30 days old) get the 50K/day cap.
  -- Established users may withdraw any amount subject to their wallet balance.
  SELECT (now() - COALESCE(created_at, now()))
    INTO v_account_age
  FROM public.profiles
  WHERE id = NEW.user_id;

  IF v_account_age IS NULL OR v_account_age > v_newuser_window THEN
    RETURN NEW;
  END IF;

  -- Newly-registered user: enforce UGX 50,000 / day withdrawal cap.
  SELECT COALESCE(SUM(amount),0)::bigint
    INTO v_today_amount
  FROM public.withdrawal_requests
  WHERE user_id = NEW.user_id
    AND created_at >= date_trunc('day', now())
    AND status NOT IN ('rejected','cancelled','failed')
    AND landlord_payout_id IS NULL
    AND proxy_partner_id IS NULL
    AND (TG_OP <> 'INSERT' OR NEW.id IS NULL OR id <> NEW.id);

  IF (v_today_amount + NEW.amount) > v_daily_cap THEN
    RAISE EXCEPTION 'New accounts are limited to UGX % per day for the first 30 days (today: UGX %, requested: UGX %). Try again tomorrow.',
      v_daily_cap, v_today_amount, NEW.amount
      USING ERRCODE = 'check_violation', HINT = 'new_user_daily_withdrawal_cap';
  END IF;

  RETURN NEW;
END;
$function$;