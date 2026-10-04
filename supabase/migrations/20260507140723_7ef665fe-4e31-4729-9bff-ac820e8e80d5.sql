-- The `wallets` table is now a VIEW over wallets_physical + v_user_wallet_strict
-- (no physical withdrawable_balance cache to lift). The previous body errored
-- with "cannot update view wallets" and silently failed inside approve-withdrawal,
-- leaving the stale cached_available=0 to veto valid withdrawals.
--
-- Replace with a no-op that simply reports the strict ledger figure so
-- callers continue to function without throwing.
CREATE OR REPLACE FUNCTION public.lift_withdrawable_to_ledger(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_strict numeric := 0;
  v_holds  numeric := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_user');
  END IF;

  SELECT COALESCE(withdrawable, 0), COALESCE(pending_holds, 0)
    INTO v_strict, v_holds
    FROM public.v_user_wallet_strict
   WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'no_op', true,
    'note', 'wallets is a ledger-derived view; no cache to lift',
    'strict_withdrawable', v_strict,
    'pending_holds', v_holds
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.lift_withdrawable_to_ledger(uuid)
  TO authenticated, service_role;