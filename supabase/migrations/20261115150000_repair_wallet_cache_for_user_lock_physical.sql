-- repair_wallet_cache_for_user locked public.wallets ... FOR UPDATE.
-- public.wallets is a view over
--   wallets_physical wp LEFT JOIN wallet_balances_projection p
-- so that statement fails with SQLSTATE 0A000:
--   FOR UPDATE cannot be applied to the nullable side of an outer join.
-- repair_wallet_cache_drift catches the error and continues, so a drifted
-- wallet is never repaired while the cron still reports success.
--
-- Lock the base row on wallets_physical, then read public.wallets without
-- FOR UPDATE. Signature, SECURITY DEFINER, search_path, return shapes,
-- wallet.sync_authorized and the UPDATE through the view are unchanged.
--
-- Live pg_get_functiondef md5 this replaces: 0ca858de83e12487aa5bb0a3b5792c95.
-- EXECUTE stays with the owner (postgres) and service_role.

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.repair_wallet_cache_for_user(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_strict record;
  v_before record;
BEGIN
  SELECT withdrawable, float_balance, advance_balance INTO v_strict FROM public.wallet_strict_for_user(p_user_id);
  IF v_strict IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_strict_row'); END IF;
  PERFORM 1 FROM public.wallets_physical WHERE user_id = p_user_id FOR UPDATE;
  SELECT COALESCE(withdrawable_balance,0) AS w, COALESCE(float_balance,0) AS f, COALESCE(advance_balance,0) AS a
    INTO v_before FROM public.wallets WHERE user_id = p_user_id;
  IF v_before IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_wallet_row'); END IF;
  IF v_before.w = COALESCE(v_strict.withdrawable,0) AND v_before.f = COALESCE(v_strict.float_balance,0) AND v_before.a = COALESCE(v_strict.advance_balance,0) THEN
    RETURN jsonb_build_object('ok', true, 'no_op', true);
  END IF;
  PERFORM set_config('wallet.sync_authorized', 'true', true);
  UPDATE public.wallets SET withdrawable_balance = COALESCE(v_strict.withdrawable, 0), float_balance = COALESCE(v_strict.float_balance, 0), advance_balance = COALESCE(v_strict.advance_balance, 0), balance = COALESCE(v_strict.withdrawable, 0) + COALESCE(v_strict.float_balance, 0), updated_at = now() WHERE user_id = p_user_id;
  PERFORM set_config('wallet.sync_authorized', 'false', true);
  RETURN jsonb_build_object('ok', true, 'before', to_jsonb(v_before), 'after', jsonb_build_object('w', v_strict.withdrawable, 'f', v_strict.float_balance, 'a', v_strict.advance_balance));
END;
$function$;

REVOKE ALL ON FUNCTION public.repair_wallet_cache_for_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repair_wallet_cache_for_user(uuid) TO service_role;
