CREATE OR REPLACE FUNCTION public.create_pending_portfolio(
  p_partner_id uuid,
  p_amount numeric,
  p_duration_months integer,
  p_roi_percentage numeric,
  p_roi_mode text,
  p_nickname text,
  p_raw_token text
)
RETURNS TABLE(portfolio_id uuid, portfolio_code text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_partner_email text;
  v_partner_phone text;
  v_ref text;
  v_pid uuid;
  v_pin text;
  v_is_partner boolean := false;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING HINT = 'not_signed_in';
  END IF;

  IF NOT public.is_partner_ops(v_caller) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING HINT = 'only_partner_ops_can_create_portfolios';
  END IF;

  IF p_amount IS NULL OR p_amount < 20000 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING HINT = 'amount_below_minimum';
  END IF;

  IF p_duration_months IS NULL OR p_duration_months < 1 OR p_duration_months > 60 THEN
    RAISE EXCEPTION 'INVALID_DURATION' USING HINT = 'duration_out_of_range';
  END IF;

  IF p_roi_percentage IS NULL OR p_roi_percentage <= 0 OR p_roi_percentage > 100 THEN
    RAISE EXCEPTION 'INVALID_ROI' USING HINT = 'roi_out_of_range';
  END IF;

  IF p_roi_mode NOT IN ('monthly_payout','monthly_compounding') THEN
    RAISE EXCEPTION 'INVALID_MODE' USING HINT = 'roi_mode_invalid';
  END IF;

  IF p_raw_token IS NULL OR length(p_raw_token) < 32 THEN
    RAISE EXCEPTION 'INVALID_TOKEN' USING HINT = 'token_too_short';
  END IF;

  SELECT email, phone INTO v_partner_email, v_partner_phone
  FROM public.profiles
  WHERE id = p_partner_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PARTNER_NOT_FOUND' USING HINT = 'profile_missing';
  END IF;

  IF v_partner_email IS NULL AND v_partner_phone IS NULL THEN
    RAISE EXCEPTION 'PARTNER_MISSING_CONTACT' USING HINT = 'partner_has_no_email_or_phone';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = p_partner_id
      AND role = 'supporter'
  ) OR EXISTS (
    SELECT 1
    FROM public.investor_portfolios
    WHERE investor_id = p_partner_id
  )
  INTO v_is_partner;

  IF NOT COALESCE(v_is_partner, false) THEN
    RAISE EXCEPTION 'NOT_REGISTERED_PARTNER' USING HINT = 'partner_requires_supporter_role_or_existing_portfolio';
  END IF;

  v_ref := 'WIP' ||
    to_char(now() AT TIME ZONE 'UTC', 'YYMMDD') ||
    lpad((floor(random()*9000)+1000)::int::text, 4, '0');
  v_pin := lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount,
    roi_percentage, roi_mode, duration_months, payout_day,
    status, portfolio_pin, activation_token, auto_reinvest
  )
  VALUES (
    p_partner_id, p_partner_id, v_ref, p_amount,
    p_roi_percentage, p_roi_mode, p_duration_months, 15,
    'awaiting_partner_details', v_pin, gen_random_uuid(), false
  )
  RETURNING id INTO v_pid;

  INSERT INTO public.portfolio_completion_tokens (
    portfolio_id, partner_id, token_hash,
    email_snapshot, phone_snapshot, created_by
  )
  VALUES (
    v_pid, p_partner_id, encode(digest(p_raw_token, 'sha256'), 'hex'),
    v_partner_email, v_partner_phone, v_caller
  );

  INSERT INTO public.audit_logs (
    user_id, action_type, table_name, record_id, metadata
  ) VALUES (
    v_caller, 'create_pending_portfolio', 'investor_portfolios', v_pid,
    jsonb_build_object(
      'partner_id', p_partner_id,
      'amount', p_amount,
      'roi_percentage', p_roi_percentage,
      'duration_months', p_duration_months,
      'roi_mode', p_roi_mode,
      'nickname', p_nickname,
      'reason', 'partner_completion_invite_sent'
    )
  );

  RETURN QUERY SELECT v_pid, v_ref;
END;
$function$;