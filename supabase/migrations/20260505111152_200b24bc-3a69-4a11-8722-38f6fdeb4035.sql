CREATE OR REPLACE FUNCTION public.admin_reseed_wallet_cache(
  p_user_id uuid,
  p_withdrawable numeric,
  p_balance numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('wallet.sync_authorized', 'true', true);
  UPDATE public.wallets
  SET withdrawable_balance = GREATEST(0, p_withdrawable),
      balance = GREATEST(0, p_balance),
      updated_at = now()
  WHERE user_id = p_user_id;
  PERFORM set_config('wallet.sync_authorized', 'false', true);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_reseed_wallet_cache(uuid, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_reseed_wallet_cache(uuid, numeric, numeric) TO service_role;