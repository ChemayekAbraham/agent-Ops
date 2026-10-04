DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT user_id
    FROM public.general_ledger
    WHERE ledger_scope = 'wallet'
  LOOP
    BEGIN
      PERFORM public.recompute_wallet_buckets(r.user_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'recompute failed for %: %', r.user_id, SQLERRM;
    END;
  END LOOP;
END $$;