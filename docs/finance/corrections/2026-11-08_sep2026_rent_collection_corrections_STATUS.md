# September 2026 rent-collection accounting corrections: status

Batch `acct_corr_202611`. Accounting records only, no money movement (CFO instruction 2026-11-08).

| Step | Status |
|---|---|
| Migration `20261108150000_money_in_exclusions_and_correction_register` | Applied to production 2026-11-08 (CFO approved) |
| Migration `20261108150100_legacy_fee_path_cap_and_reversed_rows` | Applied to production 2026-11-08 (CFO approved) |
| Read-only preview | Run 2026-11-08 after the migrations: matched the approved schedule line for line |
| Batch `2026-11-08_sep2026_rent_collection_corrections.sql` | **Posted** 2026-11-08 (CFO approved), journal dates = original September entries, no field rulings |
| Merge to `lovable` | Not done |

## Posted

| Item | Lines | UGX | Entry |
|---|---|---|---|
| A: tenant balances restored | 18 Rent Plans | 2,167,625 | `rent_requests.amount_repaid` only; status unchanged |
| B: unsupported receipts contra | 56 receipts | 8,302,829 | DR A3 / CR A5 |
| C2: fees above the Rent Plan fee | 21 | 890,537 | Original fee group reversed, correct fee rebooked (net DR R1 / CR L7) |
| C3: fees of reversed collections | 23 | 1,469,794 | DR R1 / CR L7 |

Verification (read-only, after posting): 103 groups, 253 legs, all platform scope, every group balanced
(DR = CR = 10,805,168), journal dates 2026-09-10 to 2026-09-16; no wallet-scope leg; every correction group
excluded from Money In; 18 balance-history entries `cfo_approved_acct_corr_202611_unlanded_collections`;
audit `accounting_correction_batch_posted`.

Money In, September 2026: Tenant Products and Services 162,419,916 -> 69,763,233; Revenue Collected
25,157,934 -> 8,844,767. No other month changed.

The 440 duplicate-collection fee groups (UGX 15,996,841) were already reversed by Finance on 2026-10-01; not reposted.

## Open

- Field-verification rulings: any change goes through `_rollback.sql` (counter-entries) and a new batch, with CFO approval.
- Rent Plan `2a7ea9c7` is fully repaid but left `repaying` (status changes fire bonus and referral triggers).
- UGX 93,764 of float-backed overpayments on 3 Rent Plans stays as a credit in A3; no refund.
