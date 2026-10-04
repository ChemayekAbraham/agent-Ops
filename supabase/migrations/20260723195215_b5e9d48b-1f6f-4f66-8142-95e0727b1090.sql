
-- Swap the wallets view: same shape, now indexed on projection.
CREATE OR REPLACE VIEW public.wallets AS
SELECT
  wp.id,
  wp.user_id,
  COALESCE(p.total_visible, 0) AS balance,
  wp.created_at,
  wp.updated_at,
  wp.locked_balance,
  wp.currency,
  COALESCE(p.withdrawable, 0) AS withdrawable_balance,
  COALESCE(p.float_balance, 0) AS float_balance,
  COALESCE(p.advance_balance, 0) AS advance_balance
FROM public.wallets_physical wp
LEFT JOIN public.wallet_balances_projection p ON p.user_id = wp.user_id;

-- Swap get_user_wallet_view to read from projection too.
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
    -- Lazy-init if a wallet exists but the projection row somehow doesn't yet.
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

-- Strict withdrawal balance RPC — clamped to projection, still ledger-derived.
CREATE OR REPLACE FUNCTION public.get_user_available_balance(p_user_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE((
    SELECT withdrawable FROM public.wallet_balances_projection WHERE user_id = p_user_id
  ), 0::numeric);
$$;

GRANT EXECUTE ON FUNCTION public.get_user_available_balance(uuid) TO authenticated, service_role;
