# 213 — Apophia's UGX 937,500 bank payout had no own-cash claim (2026-10-09)

**Status: BUILT 2026-10-09, migration `20261009120000` NOT applied.**

## What happened
Tugabirwe Apophia (`f7a64907…`) ran out of float at 17:32 UTC on 2026-10-08 and the next top-up (1.5M, TID 44095559427) only landed 07:25 UTC on 10-09. Five payouts went out in between with no float. Four were filed as pending own-cash claims. Withdrawal `6a370ad0` (UGX 936,000 + 1,500 fee, bank transfer to DFCU "Namulindwa Immaculate") was filed `needs_review` with no receivable, because bank-transfer payouts are treated as treasury-funded (doc 134).

Her owed total read 987,500; with this payout it is 1,925,000.

## Change
Migration adds two `pending_reimbursement` advances (payout 936,000, telecom 1,500) for `6a370ad0` and syncs `merchant_payout_funding.receivable_recorded`. The note avoids the `Phase 6 classification:` prefix so the reconciler's cleanup will not delete it. Not a payable until `is_evidenced`.

## Open
- Josh's instruction; no Finance evidence that the money was Apophia's own (a DFCU transfer to Immaculate's name looks like the BAITA treasury pattern in doc 134). Finance should confirm before settlement.
- Emma Maiso: Josh says the 3M float (TID 158376088074) was meant to cover the 1.8M payout `59ae76d0`, so the 1,430,500 claim is double-counted. Closing the claim alone would leave her float overstated by 1,430,500; needs a float delta decision. Not part of this migration.
