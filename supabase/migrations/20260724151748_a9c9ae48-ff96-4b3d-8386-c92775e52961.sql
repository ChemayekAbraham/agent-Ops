CREATE OR REPLACE FUNCTION public.get_authoritative_wallet(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_projection record;
  v_view jsonb;
  v_withdrawable numeric := 0;
  v_float numeric := 0;
  v_advance numeric := 0;
  v_pending numeric := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'user_id', NULL,
      'withdrawable', 0,
      'float', 0,
      'advance', 0,
      'pending_holds', 0,
      'cache', jsonb_build_object('withdrawable', 0, 'float', 0, 'advance', 0),
      'drift', jsonb_build_object('withdrawable', 0, 'float', 0, 'advance', 0)
    );
  END IF;

  SELECT
    COALESCE(withdrawable, 0) AS withdrawable,
    COALESCE(float_balance, 0) AS float_balance,
    COALESCE(advance_balance, 0) AS advance_balance,
    COALESCE(pending_holds, 0) AS pending_holds
  INTO v_projection
  FROM public.wallet_balances_projection
  WHERE user_id = p_user_id;

  IF FOUND THEN
    v_withdrawable := v_projection.withdrawable;
    v_float := v_projection.float_balance;
    v_advance := v_projection.advance_balance;
    v_pending := v_projection.pending_holds;
  ELSE
    -- Keep first-login/new-wallet behaviour aligned with the canonical wallet view.
    v_view := public.get_user_wallet_view(p_user_id);
    v_withdrawable := COALESCE((v_view->>'withdrawable')::numeric, 0);
    v_float := COALESCE((v_view->>'float_balance')::numeric, 0);
    v_advance := COALESCE((v_view->>'advance_balance')::numeric, 0);
    v_pending := COALESCE((v_view->>'pending_holds')::numeric, 0);
  END IF;

  RETURN jsonb_build_object(
    'user_id', p_user_id,
    'withdrawable', v_withdrawable,
    'float', v_float,
    'advance', v_advance,
    'pending_holds', v_pending,
    'cache', jsonb_build_object(
      'withdrawable', v_withdrawable,
      'float', v_float,
      'advance', v_advance
    ),
    'drift', jsonb_build_object(
      'withdrawable', 0,
      'float', 0,
      'advance', 0
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_authoritative_wallet(uuid) TO authenticated, service_role;