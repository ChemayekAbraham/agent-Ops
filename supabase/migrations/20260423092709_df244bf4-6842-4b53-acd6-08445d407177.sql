-- 2a. Enforcement trigger: reject any unauthorized wallet bucket mutation
CREATE OR REPLACE FUNCTION public.enforce_wallet_ledger_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- If no bucket fields changed, allow (e.g. metadata-only updates)
  IF OLD.balance              IS NOT DISTINCT FROM NEW.balance
 AND OLD.withdrawable_balance IS NOT DISTINCT FROM NEW.withdrawable_balance
 AND OLD.float_balance        IS NOT DISTINCT FROM NEW.float_balance
 AND OLD.advance_balance      IS NOT DISTINCT FROM NEW.advance_balance THEN
    RETURN NEW;
  END IF;

  -- Only the ledger sync path (apply_wallet_movement / sync_wallet_from_ledger)
  -- sets this session flag. All other writes are rejected.
  IF current_setting('wallet.sync_authorized', true) = 'true' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Wallet bucket mutation forbidden. Use create_ledger_transaction; balances are derived from the ledger only. (changed: balance % -> %, withdrawable % -> %, float % -> %, advance % -> %)',
    OLD.balance, NEW.balance,
    OLD.withdrawable_balance, NEW.withdrawable_balance,
    OLD.float_balance, NEW.float_balance,
    OLD.advance_balance, NEW.advance_balance;
END;
$$;

DROP TRIGGER IF EXISTS enforce_wallet_ledger_only ON public.wallets;
CREATE TRIGGER enforce_wallet_ledger_only
BEFORE UPDATE ON public.wallets
FOR EACH ROW
EXECUTE FUNCTION public.enforce_wallet_ledger_only();

-- 2b. Revoke direct UPDATE on bucket columns (defense in depth)
REVOKE UPDATE (balance, withdrawable_balance, float_balance, advance_balance)
  ON public.wallets FROM authenticated, anon, PUBLIC;

-- service_role keeps UPDATE so SECURITY DEFINER functions owned by postgres still work,
-- but they MUST set wallet.sync_authorized=true to pass the trigger.

COMMENT ON TRIGGER enforce_wallet_ledger_only ON public.wallets IS
  'Phantom-money lockdown: only the ledger sync path (which sets wallet.sync_authorized=true) may change wallet bucket fields. Any other UPDATE is rejected. Installed 2026-04-23 after CFO phantom-wallet incident.';