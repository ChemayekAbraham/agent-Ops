# Balance Sheet receivables — accounting corrections

Goal: make each product family's Book of Accounts balance equal its operational
balance, give every product its own accounting identity, and stop recognising
money nobody owes yet. Landlord is already exact and will not be touched.

All work is additive and reversal-based. Nothing is deleted, no operational
record (rent plan, advance, note, subscription, collection) is altered, and
every correction carries a written reason and an audit entry.

## Correction 1 — Partner: stop recognising notes that were never activated

238,040,000 across 74 promissory notes sitting at `pending` is recognised as a
receivable in both the ledger and the operational view.

- Reverse the receivable legs for the 74 pending notes with balanced correction
  entries dated today, one group per note, reason recorded.
- Change the recognition rule so a note becomes a receivable only on
  activation, and the operational receivables view excludes pending notes.
- Expected result: family balance 982,998,008 → 744,958,008, matching the 1,377
  activated notes exactly.
- Also flag for a later task: only one settlement (500,000) has ever been posted
  against 1,453 raised legs, so collections are not clearing. That is a
  collection-posting gap, not an overstatement, and is out of scope here.

## Correction 2 — Tenant: clear the unsupported rent receivable residue

A3 carries 365,679,158 more than tenants actually owe. Before reversing
anything, each contributing posting pattern is measured separately so the
correction is provably equal to the unsupported amount and no live balance is
touched:

1. Per-plan comparison: receivable raised minus receivable cleared, against
   each plan's own outstanding amount.
2. Classify the gap into: plans that closed without their receivable being
   cleared, repayments that reduced the tenant balance without a receivable
   credit, and collection-era postings with no plan behind them.
3. Reverse only the classified unsupported amount, in per-plan groups, with the
   classification recorded on each group. Anything that cannot be tied to a
   plan is reported back rather than reversed.
4. Re-verify: A3 rent portion must equal the operational open-plan figure, with
   zero over-reversed or double-reversed legs.

## Correction 3 — Tenant Service Charges get their own account

- Add a receivable account for Tenant Service Charges and move the existing
  `fee_receivable_created` balance (50,773,021) out of the rent line into it.
- Reconcile it to the operational charge debt (40,030,559) and reverse the
  10,742,462 that has no charge behind it, per tenant, with reasons.
- Add service charges to the operational receivables view so the Balance Sheet
  sub-row shows a real amount instead of zero.

## Correction 4 — Business Advances get a named nil line

- Add a Business Advances receivable account and recognition path that fires on
  disbursement only.
- All 73 requests are pending, so the opening balance is nil. The line exists
  and reads zero — no amount is inferred.

## Correction 5 — Agent: recognise the receivables that were never raised

The single generic "Advances and Other Receivables" account is replaced by one
named account per product, and the missing balances are raised:

| Product | Operational | Now in ledger |
| --- | --- | --- |
| Agent Advances | 50,378,481 | mixed into the generic net |
| Advance Access Fees | 13,747,193 | not raised |
| Merchandise & Smartphone Recovery | 5,488,790 | not raised |
| Bike Recoveries | 2,857,249 | not raised |
| Credit Access Draws | 2,773,291 | not raised |
| Merchandise Credit Sales | 8,132,436 | not raised, and missing from the operational view too |

- Create the named accounts, reclassify the existing A4 legs onto the correct
  product, and raise the shortfall per product as balanced opening entries tied
  to the individual advance, plan, draw or sale.
- Add Merchandise Credit Sales to the operational receivables view.
- Leave the 274 `pending_cfo` credit draws (405,036,280) unrecognised — correct
  as they stand.
- Service Centre Receivables and Service Centre Advances have no rows at all:
  create the named accounts and recognition paths so the lines exist and read
  zero. No amount is invented.

## Correction 6 — Balance Sheet presentation

- Family headings already read as product families; keep them.
- Show every product as its own sub-line under its family, sourced only from
  the server breakdown, including the nil lines for Business Advances, Service
  Centre Receivables and Service Centre Advances.
- No amount on the statement is computed in the browser.

## Order of work and gates

1. Partner de-recognition (self-contained, smallest risk).
2. Agent accounts + missing recognition.
3. Tenant service charge split.
4. Business Advances and Service Centre nil accounts.
5. Tenant A3 residue — measured, classified, then reversed, last because it is
   the largest and most entangled.
6. Presentation, after the numbers tie out.

After each step: re-read the family balance against its operational source and
confirm zero unsupported, over-reversed or double-reversed legs before moving
on. Any step whose measured gap does not match the audit figure stops and is
reported instead of posted.

## Technical notes

- New codes in `ledger_account_catalog` for tenant service charges, business
  advances, and each agent product including the two service centre lines;
  `ledger_account_map` entries for their categories; new categories added to
  the ledger category allowlist in the same migration that uses them.
- Reclassification happens in the `sofp_ledger_legs` resolver so history is
  re-read correctly rather than rewritten, mirroring the earlier A2 direction
  fix.
- Corrections post as balanced `admin_correction` groups via
  `create_ledger_transaction`; no wallet bucket is touched, so no wallet write
  path or guard is involved, and `apply_wallet_movement` stays the sole wallet
  writer.
- Recognition paths are SECURITY DEFINER triggers/RPCs alongside the existing
  `recognise_landlord_receivable` / `recognise_partner_receivable` pattern.
- `v_receivables_lines` gains service charge, merchandise credit sale and
  business advance sources, and drops pending promissory notes.
- Live schema is verified before each migration; `npm run guard:all` runs before
  any step is called done.
