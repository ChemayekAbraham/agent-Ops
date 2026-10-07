# Two merchandise categories: Company issued and Out-sourced

## What changes for users

Every storefront item gets a category, and the category decides what happens after the order is approved.

**1. Company issued.** The company makes these items and hands them over in person.
- Approval goes through the usual dashboards. No money is sent to the agent's wallet.
- The order waits as "Awaiting handover" until a company handler presses **Confirm issued**.
- On that confirmation the order is marked Issued and the repayment plan starts. Wallet recovery begins only then.
- Items: Company Ids, Jumper white, Press Jacket, Table mount, welile customized, Welile Evidence, Welile Jumper, Welile Polo, Welile Polo black, Light signage, customized Bill Board, Pull-Up signage, signages.

**2. Out-sourced.** The agent buys these items from outside suppliers.
- Approval goes through the usual dashboards, then the CFO disburses the money to the agent's wallet.
- The repayment plan starts automatically when the CFO disburses.
- Items: Audrey chair, black chair, laptops, office chair, office table, scholar chair, table, waiting chair.

**On screen**
- The CMO Storefront Catalog gets a Category column and filter, and a Category picker in Add/Edit item.
- The merchandise orders and approval screens show a category badge, so a company-issued order never shows a "Disburse" button and an out-sourced order never shows "Confirm issued".
- The agent's order card explains what happens next: "Collect from the company handler" or "Money will be sent to your wallet".

## Open points (need your answer)
- **Mocoo EVS500** and **Spiro bike** are not on either list. My plan leaves them out of both categories and keeps them on the bike lease process they use now.
- The catalog has two rows both named "Welile Polo" and none named "Welile Polo black". I'll treat one as the black polo. Please confirm which one, or rename it in the catalog.
- **Who is a "company handler"?** I'm assuming CMO, Agent Ops, managers and super admins can confirm a handover. Tell me if it should be a different group.
- **Existing orders:** 44 orders are already marked issued and 8 out-sourced orders have been disbursed. These keep the plans they already have. Only new orders follow the new rules.

## Technical details
- Migration: add `merchandise_catalog.fulfilment_type text check in ('company_issued','outsourced')` (nullable, so items without a category, like the bikes, keep their current flow). Add `merchandise_sales.fulfilment_type` copied from the catalog at order time, plus `handed_over_by` / `handed_over_at`. Backfill the catalog by item name using the two lists above. The backfill is part of the migration, not a separate data change.
- Order RPCs (`agent_order_merchandise`, `agent_purchase_merchandise*`) stamp `fulfilment_type` on the sale.
- Recovery-plan creation: `create_merchandise_recovery_plan` stops creating plans at insert for typed orders. A plan is created only on (a) the handover confirmation for company issued orders, or (b) `cfo_disbursed_at` being set for out-sourced orders. Both paths are idempotent: one plan per sale.
- New SECURITY DEFINER RPC `confirm_merchandise_handover(p_sale_id, p_note)`: checks the role, requires a company issued order that is fully approved and not yet handed over, sets `order_status='issued'` and the handover fields, creates the plan, emits a `system_event`, and writes an `audit_logs` row with a reason of at least 10 characters. It does not touch the wallet or the ledger.
- CFO disbursement for merchandise refuses company issued orders on the server, so money can't go out by mistake.
- Before writing anything, check the live function bodies, because the migrations folder isn't reliable. Run `npm run guard:all`. For the UI: catalog column, picker and badges in `MerchandiseManager.tsx`, the Confirm issued button on the approval and orders views, and the copy on the agent order card in `MerchandiseStore.tsx`.
