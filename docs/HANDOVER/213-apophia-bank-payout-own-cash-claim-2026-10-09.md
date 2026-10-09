# 213 — Apophia's UGX 937,500 bank payout had no own-cash claim (2026-10-09)

**Status: APPLIED 2026-10-09 (migrations `20261009120000` Apophia, `20261009130000` Emma).**

## What happened
Tugabirwe Apophia (`f7a64907…`) ran out of float at 17:32 UTC on 2026-10-08 and the next top-up (1.5M, TID 44095559427) only landed 07:25 UTC on 10-09. Five payouts went out in between with no float. Four were filed as pending own-cash claims. Withdrawal `6a370ad0` (UGX 936,000 + 1,500 fee, bank transfer to DFCU "Namulindwa Immaculate") was filed `needs_review` with no receivable, because bank-transfer payouts are treated as treasury-funded (doc 134).

Her owed total read 987,500; with this payout it is 1,925,000.

## Change
Migration adds two `pending_reimbursement` advances (payout 936,000, telecom 1,500) for `6a370ad0` and syncs `merchant_payout_funding.receivable_recorded`. The note avoids the `Phase 6 classification:` prefix so the reconciler's cleanup will not delete it. Not a payable until `is_evidenced`.

## Emma Maiso (same doc)
Payout `59ae76d0` (1.8M): the 3M float (TID158376088074, 18:18:05 UTC) was ingested at 18:19:01, after the payout reserved at 18:18:22, so UGX 1,430,500 was filed as her own money and the 3M was then credited in full (float overstated by the same amount). Josh: the 3M was meant to cover the payout. Migration `20261009130000` books the missing float use (float 1,794,000 -> 363,500) and rejects both claims. Dry-run first (rolled back), then applied. Owed 2,719,408 -> 1,288,908; net unchanged at -925,408. Principal leg uses reference `-merchant-float-consume-topup-cover` because `uq_general_ledger_reference_dedupe` blocks a second `-merchant-float-consume` cash_out.

## Root cause, not fixed
Ingestion lag (~1 min) lets a payout reserve before its top-up is visible. Not addressed here.

## Open
- Apophia: Josh's instruction; no Finance evidence that the money was Apophia's own (a DFCU transfer to Immaculate's name looks like the BAITA treasury pattern in doc 134). Finance should confirm before settlement.
