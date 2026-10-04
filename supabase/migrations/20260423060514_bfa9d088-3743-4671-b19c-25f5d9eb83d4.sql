ALTER TABLE public.general_ledger ENABLE TRIGGER general_ledger_route_buckets;
ALTER TABLE public.general_ledger REPLICA IDENTITY FULL;

-- Reconciliation: replay the ledger for every drifting wallet.
-- recompute_wallet_buckets() is the source of truth and bypasses guards
-- via wallet.sync_authorized. The migration itself is the audit trail.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT w.user_id,
           w.balance AS old_balance,
           w.withdrawable_balance AS old_w,
           w.float_balance AS old_f,
           w.advance_balance AS old_a,
           (w.balance - (w.withdrawable_balance + w.float_balance + w.advance_balance)) AS drift
    FROM public.wallets w
    WHERE w.balance <> (w.withdrawable_balance + w.float_balance + w.advance_balance)
  LOOP
    RAISE NOTICE 'Reconciling user=% drift=% (was balance=%, w=%, f=%, a=%)',
      r.user_id, r.drift, r.old_balance, r.old_w, r.old_f, r.old_a;
    PERFORM public.recompute_wallet_buckets(r.user_id);
  END LOOP;
END$$;

-- Hard invariant trigger
CREATE OR REPLACE FUNCTION public.tr_enforce_bucket_invariant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_authorized text;
BEGIN
  v_authorized := current_setting('wallet.sync_authorized', true);
  IF v_authorized = 'true' THEN
    RETURN NEW;
  END IF;

  IF ABS(COALESCE(NEW.balance, 0)
        - (COALESCE(NEW.withdrawable_balance, 0) + COALESCE(NEW.float_balance, 0))) > 0.01 THEN
    RAISE EXCEPTION
      'BUCKET_INVARIANT_VIOLATION: balance (%) must equal withdrawable_balance (%) + float_balance (%) for user %. Use apply_wallet_movement / a ledger entry instead of a direct UPDATE.',
      NEW.balance, NEW.withdrawable_balance, NEW.float_balance, NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_bucket_invariant ON public.wallets;
CREATE TRIGGER enforce_bucket_invariant
  BEFORE UPDATE OF balance, withdrawable_balance, float_balance, advance_balance
  ON public.wallets
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_enforce_bucket_invariant();

DO $$
DECLARE v_remaining int;
BEGIN
  SELECT COUNT(*) INTO v_remaining
  FROM public.wallets
  WHERE balance <> (withdrawable_balance + float_balance + advance_balance);
  RAISE NOTICE 'Wallet reconciliation complete. Remaining drifting wallets: %', v_remaining;
END$$;