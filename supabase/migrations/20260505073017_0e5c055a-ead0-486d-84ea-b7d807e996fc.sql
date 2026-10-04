DO $$
DECLARE r record;
BEGIN
  PERFORM set_config('wallet.sync_authorized', 'true', true);
  FOR r IN SELECT user_id FROM public.wallet_anchored_drift_view LOOP
    BEGIN
      PERFORM public.reseed_anchored_withdrawable(r.user_id, 'CFO bulk reconciliation: clear cache excess');
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'reseed failed % : %', r.user_id, SQLERRM;
    END;
  END LOOP;
END $$;