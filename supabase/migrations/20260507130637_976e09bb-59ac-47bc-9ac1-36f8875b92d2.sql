
-- One-time repair: for every user with a wallet_transfer cash_in leg whose
-- bucket cache is below the strict ledger figure, reseed withdrawable to
-- the strict figure (anchored, ledger-derived). Safe: the strict figure is
-- the canonical truth and can never inflate beyond what the ledger owes.
DO $$
DECLARE
  r record;
  v_strict numeric;
BEGIN
  PERFORM set_config('wallet.sync_authorized', 'true', true);

  FOR r IN
    SELECT DISTINCT gl.user_id
    FROM public.general_ledger gl
    WHERE gl.category = 'wallet_transfer'
      AND gl.direction = 'cash_in'
      AND gl.created_at >= now() - interval '60 days'
  LOOP
    BEGIN
      SELECT withdrawable
        INTO v_strict
        FROM public.v_user_wallet_strict
       WHERE user_id = r.user_id;

      IF v_strict IS NULL THEN CONTINUE; END IF;

      UPDATE public.wallets_physical
         SET withdrawable_balance = v_strict,
             updated_at = now()
       WHERE user_id = r.user_id
         AND withdrawable_balance < v_strict;
    EXCEPTION WHEN OTHERS THEN
      -- Skip and continue; we don't want one bad wallet to abort the batch.
      RAISE NOTICE 'reseed skipped for %: %', r.user_id, SQLERRM;
    END;
  END LOOP;
END$$;
