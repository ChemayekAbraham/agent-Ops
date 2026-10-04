CREATE OR REPLACE FUNCTION public.get_user_wallet_view(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
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

  RETURN COALESCE(v, jsonb_build_object(
    'user_id', p_user_id, 'withdrawable', 0, 'float_balance', 0,
    'advance_balance', 0, 'pending_holds', 0, 'total_visible', 0,
    'restricted_held', 0
  ));
END;
$function$;

-- Seed projection for the affected user so their wallet renders immediately
SELECT public.refresh_wallet_projection_for('27f9f7bf-7123-46ca-804b-59cd0ad022af'::uuid);