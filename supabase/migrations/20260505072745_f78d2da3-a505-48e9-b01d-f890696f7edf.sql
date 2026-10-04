-- Force full wallet reconciliation: wipe cached buckets and recompute strictly from ledger for every wallet.
DO $$
DECLARE
  r record;
BEGIN
  -- 1. Authorize wallet writes for this transaction
  PERFORM set_config('wallet.sync_authorized', 'true', true);

  -- 2. Hard-reset every cached bucket to zero so nothing carries over
  UPDATE public.wallets
     SET withdrawable_balance = 0,
         float_balance        = 0,
         advance_balance      = 0,
         balance              = 0,
         updated_at           = now();

  -- 3. Recompute every wallet from the ledger (sole source of truth)
  FOR r IN SELECT user_id FROM public.wallets LOOP
    BEGIN
      PERFORM public.recompute_wallet_buckets(r.user_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'recompute failed for %: %', r.user_id, SQLERRM;
    END;
  END LOOP;
END $$;

-- 4. Reseed anchored withdrawable so anchored wallets snap to strict ledger figure
DO $$
DECLARE
  r record;
BEGIN
  PERFORM set_config('wallet.sync_authorized', 'true', true);
  FOR r IN SELECT user_id FROM public.wallet_fresh_start_anchors LOOP
    BEGIN
      PERFORM public.reseed_anchored_withdrawable(r.user_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'reseed_anchored_withdrawable failed for %: %', r.user_id, SQLERRM;
    END;
  END LOOP;
END $$;