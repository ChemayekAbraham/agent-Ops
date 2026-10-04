# Balance Sheet: fold partner and agent obligations into Landlord Float — Self Managed

Presentation-only change to the CFO Balance Sheet. No ledger accounts, mappings, ownership or posting logic change.

## What changes on screen

The standalone **Partner and Agent Obligations** block (and its subtotal) disappears. Its four lines move under **Landlord Float — Self Managed**, inside Market Place Liabilities:

```text
Market Place Liabilities
  Landlord Float — Company Managed            X
  Landlord Float — Self Managed               Y
     Partner Portfolio Capital Held           7,560,579,314
     Partner Top-Ups Awaiting Application        83,170,234
     Partner Returns Payable                            0
     Agent Commission Payable                           0
  Total Landlord Float                        X + Y
  Withdrawal Balances                       432,383,224
  Operational Float / Merchant Agent Float / Borrowed Funds
Subtotal — Market Place Liabilities         (now includes the four lines)
Total Liabilities                            8,076,132,772  (unchanged)
```

- **Landlord Float — Self Managed** becomes the self-managed slice of L4 *plus* the four partner/agent balances, with the four shown as its indented components.
- **Total Landlord Float** = Company Managed + Self Managed.
- **Subtotal — Market Place Liabilities** rises by exactly the old Partner and Agent Obligations subtotal, so **Total Liabilities** and the balance check are unchanged.

## No double counting

Each of L2, L6, L3, L5 keeps exactly one classification target — it is only reparented, not copied. L4 (Landlord Rent Payable) keeps its own value and is never mixed with the partner accounts: it only supplies the Company/Self split of its own balance. The section total still reconciles against the RPC's `liabilities.total`, and the existing drift note will surface any mismatch.

## Technical detail

`src/components/cfo/balanceSheetClassification.ts`
- Keep `PARTNER_LIABILITY_CATEGORIES` and `LIABILITY_ACCOUNT_MAP` untouched (same accounts, same labels).
- `classifyLiabilities` keeps returning `partner` / `partnerTotal` (used as the input to the nesting, not as a separate section).
- Extend `MarketplaceRow` with an optional `component?: boolean` flag for indented child lines.
- `expandLandlordFloat(marketplace, split, partnerGroups)`: Self Managed value = proportional self share of L4 + sum of `partnerGroups`; emit each partner group after it as `component: true`; `Total Landlord Float` subtotal = L4 value + partner total. When no split is available, Self Managed still carries the partner total.

`src/components/cfo/BalanceSheetPanel.tsx`
- Pass `liabilityGroups.partner` into `expandLandlordFloat`.
- Recompute the marketplace subtotal as `marketplaceTotal + partnerTotal`.
- Delete the `Partner and Agent Obligations` sub-heading, its rows and its subtotal from all three renderers: the on-screen table, the CSV export, and the PDF export.
- Render `component` rows indented one level under Self Managed (extra indent in CSV/PDF).
- `Total Liabilities`, equity, balance check, trial balance and reconciliation blocks are untouched.
