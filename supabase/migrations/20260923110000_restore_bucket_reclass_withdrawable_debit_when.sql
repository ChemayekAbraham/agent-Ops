-- Restore the debit_when values on the two bucket_reclass* / withdrawable / L1
-- rows in ledger_account_map. At 2026-09-23 09:58:11 UTC both rows were flipped
-- from 'cash_in' to 'cash_out' (updated_at is identical on both, so this was one
-- edit, not organic drift). That's the same value used by the generic wallet/L1
-- fallback, which looks right in isolation but breaks the whole point of the
-- dedicated bucket_reclass_in/bucket_reclass_out categories: they exist so the
-- withdrawable leg and the float leg (A2, debit_when='cash_in', untouched) land
-- on OPPOSITE sides of the account map and the two-leg group nets to zero. With
-- both L1 rows back on 'cash_out', a withdrawable->float reclass prices as
-- DR L1 + DR A2 (both cash_out/cash_in respectively match debit_when on both
-- rows) and a float->withdrawable reclass prices as CR + CR — every cross-bucket
-- move gets rejected by assertLedgerGroupBalanced before anything is written.
-- See docs/HANDOVER/114-bucket-reclass-debit-when-drift.md.
--
-- The row `notes` still describe the correct, original design ("...so the pair
-- nets to zero") and were left untouched by whatever changed debit_when, which
-- is why this migration only restores the value and leaves notes as-is.

UPDATE public.ledger_account_map
SET debit_when = 'cash_in', updated_at = now()
WHERE ledger_scope = 'wallet'
  AND category IN ('bucket_reclass_in', 'bucket_reclass_out')
  AND wallet_bucket = 'withdrawable'
  AND account_code = 'L1'
  AND debit_when = 'cash_out';
