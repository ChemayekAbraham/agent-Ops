
-- Cache-up RPC: bring wallets.withdrawable_balance up to the strict
-- ledger-derived figure (v_user_wallet_strict.withdrawable + pending_holds),
-- so the strict MIN(cache, ledger) gate is no longer artificially clamped
-- by a stale cache. Never inflates beyond the ledger truth.
CREATE OR REPLACE FUNCTION public.lift_withdrawable_to_ledger(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_cached  numeric := 0;
  v_strict  numeric := 0;
  v_holds   numeric := 0;
  v_target  numeric := 0;
  v_delta   numeric := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_user');
  END IF;

  SELECT COALESCE(withdrawable_balance, 0)
    INTO v_cached
    FROM public.wallets
   WHERE user_id = p_user_id;

  SELECT COALESCE(withdrawable, 0), COALESCE(pending_holds, 0)
    INTO v_strict, v_holds
    FROM public.v_user_wallet_strict
   WHERE user_id = p_user_id;

  -- Pre-hold ledger figure (strict view already subtracts pending holds).
  v_target := GREATEST(0, v_strict + v_holds);
  v_delta  := v_target - COALESCE(v_cached, 0);

  IF v_delta <= 0 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'no_op', true,
      'cached', v_cached,
      'target', v_target
    );
  END IF;

  -- Authorize the wallet write lockdown trigger for this transaction only.
  PERFORM set_config('wallet.sync_authorized', 'true', true);

  UPDATE public.wallets
     SET withdrawable_balance = v_target,
         balance              = COALESCE(balance, 0) + v_delta,
         updated_at           = now()
   WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'lifted', v_delta,
    'previous_cached', v_cached,
    'new_cached', v_target,
    'pending_holds', v_holds
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.lift_withdrawable_to_ledger(uuid)
  TO authenticated, service_role;
