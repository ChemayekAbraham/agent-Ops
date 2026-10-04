CREATE OR REPLACE FUNCTION public.apply_wallet_movement(p_user_id uuid, p_category text, p_amount numeric, p_direction text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_route record;
  v_recover numeric;
  v_remaining numeric;
  v_current_advance numeric;
  v_current_withdrawable numeric;
  v_current_float numeric;
  v_direction text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN; END IF;

  -- Normalize legacy direction aliases ('in'/'out') used by older RPCs
  -- (e.g. process_verified_field_deposit) to the canonical credit/debit
  -- vocabulary expected by wallet_route_for_category.
  v_direction := CASE lower(coalesce(p_direction, ''))
    WHEN 'in'      THEN 'credit'
    WHEN 'inflow'  THEN 'credit'
    WHEN 'cash_in' THEN 'cash_in'
    WHEN 'credit'  THEN 'credit'
    WHEN 'out'     THEN 'debit'
    WHEN 'outflow' THEN 'debit'
    WHEN 'cash_out' THEN 'cash_out'
    WHEN 'debit'   THEN 'debit'
    ELSE p_direction
  END;

  -- ROLE-AWARE ROUTING
  SELECT * INTO v_route FROM public.wallet_route_for_category(p_user_id, p_category, v_direction);

  IF v_route.bucket = 'none' OR v_route.sign = 0 THEN
    BEGIN
      INSERT INTO public.wallet_unrouted_movements (
        user_id, category, direction, amount, bucket_returned, sign_returned
      ) VALUES (
        p_user_id, p_category, v_direction, p_amount, v_route.bucket, v_route.sign
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN;
  END IF;

  PERFORM set_config('wallet.sync_authorized', 'true', true);

  INSERT INTO public.wallets (user_id, balance) VALUES (p_user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT withdrawable_balance, float_balance, advance_balance
    INTO v_current_withdrawable, v_current_float, v_current_advance
    FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;

  IF v_route.bucket = 'withdrawable' AND v_route.sign = 1 THEN
    v_recover := LEAST(p_amount, COALESCE(v_current_advance, 0));
    v_remaining := p_amount - v_recover;
    UPDATE public.wallets
      SET advance_balance = advance_balance - v_recover,
          withdrawable_balance = withdrawable_balance + v_remaining,
          balance = (withdrawable_balance + v_remaining) + float_balance,
          updated_at = now()
      WHERE user_id = p_user_id;

  ELSIF v_route.bucket = 'withdrawable' AND v_route.sign = -1 THEN
    UPDATE public.wallets
      SET withdrawable_balance = withdrawable_balance - p_amount,
          balance = (withdrawable_balance - p_amount) + float_balance,
          updated_at = now()
      WHERE user_id = p_user_id;

  ELSIF v_route.bucket = 'float' AND v_route.sign = 1 THEN
    UPDATE public.wallets
      SET float_balance = float_balance + p_amount,
          balance = withdrawable_balance + (float_balance + p_amount),
          updated_at = now()
      WHERE user_id = p_user_id;

  ELSIF v_route.bucket = 'float' AND v_route.sign = -1 THEN
    UPDATE public.wallets
      SET float_balance = float_balance - p_amount,
          balance = withdrawable_balance + (float_balance - p_amount),
          updated_at = now()
      WHERE user_id = p_user_id;

  ELSIF v_route.bucket = 'advance_credit' THEN
    UPDATE public.wallets
      SET withdrawable_balance = withdrawable_balance + p_amount,
          advance_balance = advance_balance + p_amount,
          balance = (withdrawable_balance + p_amount) + float_balance,
          updated_at = now()
      WHERE user_id = p_user_id;

  ELSIF v_route.bucket = 'advance_repayment' THEN
    UPDATE public.wallets
      SET withdrawable_balance = withdrawable_balance - p_amount,
          advance_balance = GREATEST(0, advance_balance - p_amount),
          balance = (withdrawable_balance - p_amount) + float_balance,
          updated_at = now()
      WHERE user_id = p_user_id;
  END IF;
END;
$function$;