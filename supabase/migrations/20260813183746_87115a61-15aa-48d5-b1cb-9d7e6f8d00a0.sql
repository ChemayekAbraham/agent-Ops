CREATE OR REPLACE FUNCTION public.get_user_wallet_view(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
  v_hold numeric := 0;
  v_withdrawable numeric;
  v_total numeric;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'user_id', NULL, 'withdrawable', 0, 'float_balance', 0,
      'advance_balance', 0, 'pending_holds', 0, 'total_visible', 0,
      'restricted_held', 0
    );
  END IF;

  SELECT jsonb_build_object(
    'user_id', p.user_id,
    'withdrawable', p.withdrawable,
    'float_balance', p.float_balance,
    'advance_balance', p.advance_balance,
    'pending_holds', p.pending_holds,
    'total_visible', p.total_visible,
    'restricted_held', p.restricted_held,
    'updated_at', p.updated_at
  )
  INTO v
  FROM public.wallet_balances_projection p
  WHERE p.user_id = p_user_id;

  IF v IS NULL THEN
    PERFORM public.refresh_wallet_projection_for(p_user_id);

    SELECT jsonb_build_object(
      'user_id', p.user_id,
      'withdrawable', p.withdrawable,
      'float_balance', p.float_balance,
      'advance_balance', p.advance_balance,
      'pending_holds', p.pending_holds,
      'total_visible', p.total_visible,
      'restricted_held', p.restricted_held,
      'updated_at', p.updated_at
    )
    INTO v
    FROM public.wallet_balances_projection p
    WHERE p.user_id = p_user_id;
  END IF;

  v := COALESCE(v, jsonb_build_object(
    'user_id', p_user_id, 'withdrawable', 0, 'float_balance', 0,
    'advance_balance', 0, 'pending_holds', 0, 'total_visible', 0,
    'restricted_held', 0
  ));

  -- Capital committed to a portfolio awaiting Partner Ops approval is NOT
  -- spendable: strip it out of withdrawable and surface it as a hold so the
  -- same money cannot fund a second portfolio, a withdrawal or a transfer.
  v_hold := COALESCE(public.funder_pending_hold(p_user_id), 0);
  IF v_hold > 0 THEN
    v_withdrawable := GREATEST(0::numeric, COALESCE((v->>'withdrawable')::numeric, 0) - v_hold);
    v_total := GREATEST(0::numeric, COALESCE((v->>'total_visible')::numeric, 0) - v_hold);
    v := v
      || jsonb_build_object('withdrawable', v_withdrawable)
      || jsonb_build_object('total_visible', v_total)
      || jsonb_build_object('pending_holds', COALESCE((v->>'pending_holds')::numeric, 0) + v_hold)
      || jsonb_build_object('pending_portfolio_hold', v_hold);
  ELSE
    v := v || jsonb_build_object('pending_portfolio_hold', 0);
  END IF;

  RETURN v;
END;
$function$;