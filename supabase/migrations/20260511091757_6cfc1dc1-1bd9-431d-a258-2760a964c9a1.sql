CREATE OR REPLACE FUNCTION public.get_user_available_balance(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _withdrawable numeric := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN 0;
  END IF;

  -- SINGLE SOURCE OF TRUTH:
  -- The wallet UI (get_user_wallet_view) and the withdrawal approval guard
  -- MUST read the exact same withdrawable figure. v_user_wallet_strict already:
  --   * routes every ledger row through wallet_route_for_category
  --     (so recipient_type='user' credits land in 'withdrawable')
  --   * excludes admin_correction system_balance_correction noise
  --   * subtracts pending_holds
  --   * clamps to >= 0
  -- Reading it here eliminates the previous category-blacklist that could
  -- silently exclude legitimate CFO user credits from withdrawal eligibility.
  SELECT COALESCE(withdrawable, 0)
    INTO _withdrawable
  FROM public.v_user_wallet_strict
  WHERE user_id = p_user_id;

  RETURN COALESCE(_withdrawable, 0);
END;
$function$;