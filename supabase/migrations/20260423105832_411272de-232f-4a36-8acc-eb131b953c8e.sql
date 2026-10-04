-- =========================================================================
-- Migration 1 of 3: Neutralize sync_wallet_from_ledger to stop double-counting
-- =========================================================================
-- Context: Two triggers were independently mutating wallets.balance per
-- ledger insert:
--   (a) trg_sync_wallet_from_ledger -> sync_wallet_from_ledger()
--       (legacy: updates balance = balance ± amount)
--   (b) apply_wallet_movement() called by create_ledger_transaction
--       (current: updates withdrawable / float / advance buckets and sets
--        balance = withdrawable + float — the canonical formula)
--
-- Result: every ledger insert moved balance TWICE — once by (a) on the raw
-- delta, once by (b) on the bucket-derived total. This produced phantom
-- drift that the 15-min cron has been logging.
--
-- Fix: keep the trigger and function attached (full backward compatibility
-- — many migrations and code paths reference the symbol), but make the
-- body a pure no-op. apply_wallet_movement becomes the SOLE writer to
-- wallet bucket fields. Zero balance changes at migration time.
--
-- Rollback: replace body with the original (saved in migration history).
-- =========================================================================

CREATE OR REPLACE FUNCTION public.sync_wallet_from_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- INTENTIONAL NO-OP (2026-04-23).
  -- apply_wallet_movement() is now the sole writer to wallets.balance
  -- and the bucket fields. This trigger remains attached only for
  -- backward compatibility with code/migrations that reference its
  -- symbol. It must not mutate wallets.
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.sync_wallet_from_ledger() IS
  'NO-OP since 2026-04-23. apply_wallet_movement is the sole wallet writer. Kept attached for backward compatibility — do not delete without auditing every call site.';