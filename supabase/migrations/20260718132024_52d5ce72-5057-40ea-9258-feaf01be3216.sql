CREATE OR REPLACE FUNCTION public.enforce_kyc_withdrawal_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_daily_cap constant bigint := 50000;
  v_today_amount bigint;
  v_frozen boolean;
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

  -- Frozen accounts remain blocked.
  SELECT COALESCE(frozen, false) INTO v_frozen
  FROM public.get_kyc_effective_limits(NEW.user_id);

  IF v_frozen THEN
    RAISE EXCEPTION 'Account frozen pending review. Contact support.'
      USING ERRCODE = 'check_violation', HINT = 'kyc_frozen';
  END IF;

  -- Universal UGX 50,000 / day withdrawal cap per user.
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
    RAISE EXCEPTION 'Daily withdrawal cap of UGX % reached (today: UGX %, requested: UGX %). Try again tomorrow.',
      v_daily_cap, v_today_amount, NEW.amount
      USING ERRCODE = 'check_violation', HINT = 'daily_withdrawal_cap';
  END IF;

  RETURN NEW;
END;
$function$;