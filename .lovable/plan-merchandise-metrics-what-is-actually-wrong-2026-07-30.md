# Merchandise metrics: what is actually wrong

The numbers on this page are not mock data. Every tile reads live rows from `merchandise_purchases`, `merchandise_sales` and `merchandise_recovery_plans`. The figures look fake because three real order rows are absurdly large, and nothing in the ordering path stops them.

## Confirmed findings

**1. Three fat-finger orders create almost all of the totals**

| Client | Item | Quantity | Revenue |
|---|---|---|---|
| Kyagulanyi Benon | Company Ids | 150,000 | UGX 6,750,000,000 |
| muwanika asha | Company Ids | 100,000 | UGX 4,500,000,000 |
| Kibalama Bashir | Company Ids | 45,000 | UGX 2,025,000,000 |

Total sales across all 58 rows: 295,066 units / UGX 13,276,705,500. Those three rows alone are 295,000 units and UGX 13,275,000,000. Remove them and the real business is roughly 66 units and about UGX 1.7M of sales.

This also explains the other broken tiles: Current Stock -294,893 (173 purchased against 295,066 "sold"), Gross Profit UGX 7.37B, and Outstanding Receivables UGX 13.27B.

**2. The order function has no quantity ceiling**

`agent_order_merchandise` only rejects quantity `<= 0`. There is no upper bound and no stock check, so a mis-typed quantity is accepted and immediately turned into a sale plus a recovery plan.

**3. Duplicate orders are being created**

Eight customer/item pairs have duplicate recovery plans, several created seconds apart (tunakoza jalia x3 Jerseys, kyeyune ian x2, David Amanya x2, kirunda Ivan x2, walimbwa peter x2, Namakula Aisha x2, Chakuwa Melvine x2, Martin lukwago x2). Double-tapping the order button creates two debts for one purchase.

**4. "Recovered to Date UGX 0" is real, not a display bug**

The `recover-merchandise-from-wallets` cron runs four times daily and is active, but there are zero ledger legs with `source_table = 'merchandise_recovery_plans'`. Nothing has ever been recovered; every plan sits at its full original amount. The likely reason is that these customers have no strict withdrawable balance, but that is unverified and needs a check before any recovery-engine change.

**5. Inventory Value shows UGX 0**

Correct given the inputs: stock is negative, so `max(0, stock) * average cost` is zero. It self-corrects once quantities are sane.

## Proposed fix

**Phase 1 — clean the three bad orders (data)**
- Cancel the three oversized sales and their recovery plans (status `cancelled`, outstanding zeroed) with a reason recorded, rather than hard-deleting, so the audit trail survives.
- Same treatment for the confirmed duplicate plans, keeping the earliest of each pair.
- No wallet or ledger money moves, because nothing was ever posted against these plans.

**Phase 2 — stop it happening again (backend)**
- Add a maximum quantity per order to `agent_order_merchandise` (proposed: 20 units) plus a maximum order value guard.
- Add a short-window duplicate guard so the same customer cannot create a second identical order within a few minutes.

**Phase 3 — make the page resilient (frontend)**
- Exclude cancelled and rejected sales from the roll-up tiles.
- Flag any single sale above a sanity threshold with an "Outlier" badge in the sales table, so this is visible instead of silently poisoning the KPIs.

**Phase 4 — recovery engine check (investigation only)**
- Confirm whether recovery has never fired because customers genuinely hold zero strict withdrawable balance, or because plans are skipped for another reason. Report back before touching the function.

## Technical notes

- Data cleanup runs as update statements against `merchandise_sales` and `merchandise_recovery_plans`; the schema is unchanged.
- Guards go into the `agent_order_merchandise` database function via migration.
- Frontend edits stay inside `src/components/executive/MerchandiseManager.tsx` roll-up memos and the sales table.

## Open question

The 20-unit cap and the outlier threshold are my suggestion. Give me the numbers you want and I will use those instead.