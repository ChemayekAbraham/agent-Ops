
-- ============================================================================
-- WALLET BALANCE INVARIANT: balance = withdrawable + float + advance
-- ============================================================================

-- Step 1: One-shot reconciliation of the 5 known drifted wallets
-- Use sync_authorized session flag to bypass enforce_wallet_ledger_only lockdown
DO $$
BEGIN
  PERFORM set_config('wallet.sync_authorized', 'true', true);

  UPDATE public.wallets
  SET balance = COALESCE(withdrawable_balance, 0)
              + COALESCE(float_balance, 0)
              + COALESCE(advance_balance, 0)
  WHERE ABS(
    COALESCE(balance, 0) - (
      COALESCE(withdrawable_balance, 0)
      + COALESCE(float_balance, 0)
      + COALESCE(advance_balance, 0)
    )
  ) > 0.01;

  PERFORM set_config('wallet.sync_authorized', 'false', true);
END $$;

-- Step 2: Invariant trigger — keeps balance == sum(buckets) on every write
CREATE OR REPLACE FUNCTION public.enforce_wallet_balance_invariant()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expected NUMERIC;
BEGIN
  v_expected := COALESCE(NEW.withdrawable_balance, 0)
              + COALESCE(NEW.float_balance, 0)
              + COALESCE(NEW.advance_balance, 0);

  -- Always force balance to equal bucket sum. Any direct write to .balance
  -- is silently overridden so the displayed number can never lie.
  NEW.balance := v_expected;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_wallet_balance_invariant ON public.wallets;
CREATE TRIGGER trg_enforce_wallet_balance_invariant
  BEFORE INSERT OR UPDATE OF balance, withdrawable_balance, float_balance, advance_balance
  ON public.wallets
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_wallet_balance_invariant();
