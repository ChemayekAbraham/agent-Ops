# 265 — Float overdraft fill credit was not counted, so the same overdraft was re-filled (2026-11-10)

**Status: CODE CHANGE ON `dev/financial-ops`, NOT DEPLOYED, NOT PUSHED.** No ledger rows were changed by this fix.

## CTO ask
"My ledger is not balancing, it shows I have overdrawn the float by 580K." Wallet `ad9af2e6-…` (user `cb798acb-68bc-4b4e-a414-a3d374e030b6`).

## What was found
- The 580K is UGX **582,710**, the figure the FinOps Wallet Move panel and the `admin-withdrawable-to-float` guard compute from raw float legs. `wallets.float_balance` is floored at 0, so the card showed 0.
- Origin: 18 Aug "Merchant desk float set to 0 (books showed 631,510)" debited 631,510 while the real ledger float was 48,800 (over-debit 582,710; a set-to, not a delta). Earlier May rent allocations (819,500) and the 10 Aug return fed the same hole.
- 15 Oct `FLTDBL-20261015-2` cleared it (+582,710). Eleven minutes later `ECW-1937C1DC5E` returned 3,632,710 from a float that held 3,150,000, putting it back to -582,710 (then a 100,000 partner-funding leg).
- 10 Nov the operator ticked "acknowledge overdraft" on a 100,000 Withdrawable -> Float move. It posted `FLTFILL-bd2bdc07-…` (+582,710, `admin_correction`, `system_balance_correction`, `cash_in`) and the 100,000 reclass. Real float = +100,000, wallet card = 100,000.

## Defect
The guard (`admin-withdrawable-to-float/index.ts`) and the panel only counted `admin_correction` legs that are **debits**. The fill is an `admin_correction` **credit**, so it was ignored: the guard still read -482,710 after the fill and would have filled the same shortfall again on the next acknowledged move, each time inflating the platform-absorbed amount.

## Fix
- `supabase/functions/admin-withdrawable-to-float/index.ts`: the inline float-net fallback now also counts `admin_correction` / `system_balance_correction` credits whose `reference_id` starts `FLTFILL-`. It also filters to `wallet_bucket='float'` in the query and selects `reference_id`, so it no longer depends on a default row cap across all wallet legs (the account has 1,000+ wallet rows).
- `src/components/financial-ops/FinOpsWalletMovePanel.tsx`: the `floatNet` effect uses the same rule.
- `compute_wallet_float_net` (the RPC the function tries first) does not exist in production; the inline path is what runs.

## Verified
SQL with the new rule on this account: net **100,000** over 150 float legs (was -482,710). `npm run guard:all` passes.

## Not done / open
- Edge function not deployed; until it is, the live guard still reads -482,710 and an acknowledged move would fill again. Do not tick "acknowledge overdraft" for this user before deploy.
- Root causes remain: set-to corrections that do not use the true ledger net; rent collection and "return to platform" that can debit float below its net.
