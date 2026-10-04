---
name: CMO Merchandise Management
description: CMO dashboard Merchandise tab tracking branded merch purchases, sales, inventory, COGS/profit and client credit receivables
type: feature
---
# CMO Merchandise Management

New **Merchandise** tab on the CMO dashboard (`/cmo/dashboard?tab=merchandise`), sidebar id `merchandise`.

## Data model (Lovable Cloud)
- `merchandise_purchases`: item_name, quantity, unit_cost, total_cost, purchase_date, supplier, notes, created_by.
- `merchandise_sales`: item_name, quantity, unit_price, unit_cost (COGS/unit), total_revenue, client_name, client_phone, payment_status (`paid`|`credit`|`partial`), amount_paid, amount_outstanding, sale_date, notes, created_by.
- RLS: full access only to roles `cmo`, `manager`, `super_admin` via `has_role`. Grants to authenticated + service_role. No wallet/ledger impact (standalone marketing bookkeeping).

## Component
- `src/components/executive/MerchandiseManager.tsx`. Rendered by `CMODashboard` when `activeTab==='merchandise'` (CMODashboard is now a switch: merchandise vs internal `CMOMarketingDashboard`).
- Tables are not yet in generated Supabase types -> queried via `const db = supabase as any`.
- Derived metrics computed client-side: current stock = purchased - sold; inventory value = stock x weighted-avg purchase cost; gross profit = revenue - COGS; receivables grouped by client phone/name.
- Filters: date range, product, client. Two dialogs: Record Purchase, Record Sale (sale auto-suggests unit_cost from weighted-avg purchase cost, warns on overselling stock).
- Amounts use formatUGX.

## Automated wallet recovery (replaces manual CFO balance corrections)
When merchandise is sold on credit/partial to a **registered customer**, the cost is recovered
automatically from their Withdrawable Wallet — no more manual `CFO Debit [🔧 Balance Correction]`.

- `merchandise_sales.customer_id` (nullable) links a sale to a registered buyer.
- **`trg_create_merchandise_recovery_plan`** (AFTER INSERT on `merchandise_sales`): when
  `amount_outstanding > 0`, resolves the customer from `customer_id` or by matching
  `client_phone` to `profiles.phone` via `normalize_phone_9` (last-9-digits). If resolved,
  inserts a row into `merchandise_recovery_plans`. Unregistered buyers stay plain receivables.
- `merchandise_purchases.buyer_id`/`buyer_name`/`buyer_phone`: Record Purchase dialog now
  captures who bought the item so their wallet can be debited for the cost.
- **`trg_create_purchase_recovery_plan`** (AFTER INSERT on `merchandise_purchases`): when
  `total_cost > 0`, resolves the buyer from `buyer_id` or by matching `buyer_phone` to
  `profiles.phone` (`normalize_phone_9`). If resolved, inserts a `merchandise_recovery_plans`
  row (`sale_id NULL`, `original_amount = total_cost`, `daily_rate 0.15`). Unregistered/absent
  buyers create no plan. Recovered by the SAME daily cron; credit lands on CMO Keith Asea.
- **`merchandise_recovery_plans`**: sale_id, customer_id, item_name, original_amount,
  outstanding_balance, amount_recovered, daily_rate (0.15), status (active|completed|cancelled),
  last_recovery_at. **`merchandise_recovery_deductions`**: per-deduction audit log.
- **`recover_merchandise_from_wallets()`** (SECURITY DEFINER, EXECUTE→service_role) — pg_cron
  `recover-merchandise-from-wallets` runs **4×/day** at `0 5,11,17,23 * * *`. For each active plan reads
  STRICT withdrawable via `get_user_available_balance`, deducts
  `least(outstanding, available, greatest(round(available*0.15),1))` via
  `create_ledger_transaction`: wallet leg (`cash_out`, category `wallet_deduction`,
  recipient_type `user`, bucket `withdrawable`, description
  `Merchandise Payment – <item> (15% Wallet Recovery)` — production, shows in wallet statement)
  + **company credit leg: `platform` `cash_in`, category `debt_recovery`, recipient_type
  `operational_wallet`** — recovered money now flows into the COMPANY cash ("money we have",
  CFO `get_platform_cash_summary` totalCash), NOT a personal wallet.
  Idempotency is **per plan per hour-slot** (`merch_recover_<plan>_<YYYYMMDDHH24>`) so the 4 daily
  runs each recover once. On every deduction it inserts a `notifications` row for the paying agent
  (type `merchandise_recovery`, metadata.kind `merchandise_recovery`) — the global
  `block_all_notification_inserts` trigger now allows type `merchandise_recovery` through. Updates
  the plan, logs the deduction, keeps the originating sale in sync.
- **Storefront (agent self-order)**: `merchandise_catalog` table (item_name, description,
  unit_price, unit_cost, image_url, is_active) — leadership manage, authenticated read active.
  `agent_order_merchandise(p_catalog_id, p_quantity)` (SECURITY DEFINER, EXECUTE→authenticated)
  inserts a `credit` `merchandise_sales` row with `customer_id = auth.uid()`, so the AFTER INSERT
  trigger auto-creates a recovery plan and it shows in the CMO merchandise page. Agent UI:
  `/merchandise` (`src/pages/MerchandiseStore.tsx`) — catalog grid + "buy" + My payments
  (plans + deductions). Linked from AgentDashboard (visible card + header menu "Buy Merchandise");
  `AgentNotificationBell` taps a merchandise notification → `/merchandise`.
- RLS: cmo/cfo/manager/super_admin manage; customers can read their own plans + deductions.

## Buy-now vs installments (agent storefront)
- `merchandise_sales.payment_plan` (`full` | `installment`, default `full`).
- `agent_purchase_merchandise(p_catalog_id, p_quantity, p_payment_mode)`:
  - `full` → requires strict available balance ≥ price; debits the whole price at once (sale `paid`).
  - `installment` → charges 40% of the STRICT available wallet immediately as the first
    installment (sale `partial`), leaves the remainder outstanding; NO markup, the owed amount is
    always the selling price.
- `create_merchandise_recovery_plan` sets `daily_rate = 0.40` for installment sales and keeps 0.15
  for CMO-recorded credit sales. `recover_merchandise_from_wallets` already reads
  `plan.daily_rate`; the statement description now renders the plan's real percentage.
- Store UI (`MerchandiseStore.tsx`): two-step checkout — pick plan, then a confirm screen showing
  price, due now, balance to recover; CMO visibility is stated to the buyer.
- CMO `MerchandiseManager`: Rate column on recovery plans + Plan column on sales transactions.
- Dashboard: MerchandiseManager shows Recovered-to-Date / Customers-Repaying /
  Remaining-to-Recover / Fully-Paid KPIs, a "Merchandise Wallet Recovery (15% · up to 4×/day)"
  table, and a "Storefront Catalog" manager (Add Store Item / hide / delete).
