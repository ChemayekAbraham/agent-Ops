
CREATE OR REPLACE FUNCTION public.get_user_wallet_view(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'user_id', NULL, 'withdrawable', 0, 'float_balance', 0,
      'advance_balance', 0, 'pending_holds', 0, 'total_visible', 0,
      'withdrawable_raw', 0, 'float_raw', 0, 'advance_raw', 0,
      'restricted_held', 0
    );
  END IF;

  -- NOTE: maturity expiry is handled by the hourly cron
  -- `expire_stale_bonus_restrictions`. This function is STABLE / read-only.

  SELECT to_jsonb(s) INTO v FROM public.v_user_wallet_strict s WHERE s.user_id = p_user_id;

  IF v IS NULL THEN
    RETURN jsonb_build_object(
      'user_id', p_user_id, 'withdrawable', 0, 'float_balance', 0,
      'advance_balance', 0, 'pending_holds', 0, 'total_visible', 0,
      'withdrawable_raw', 0, 'float_raw', 0, 'advance_raw', 0,
      'restricted_held', 0
    );
  END IF;

  RETURN v || jsonb_build_object('restricted_held', COALESCE((v->>'restricted_held')::numeric, 0));
END;
$function$;
