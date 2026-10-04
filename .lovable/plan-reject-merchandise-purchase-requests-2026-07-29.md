# Reject Merchandise Purchase Requests

## Current state (verified)

- Agents order via `agent_purchase_merchandise` (catalog items) or `agent_order_smartphone` / `agent_order_spiro_bike`. All three are **instant**: they debit the wallet (or open a recovery plan) and create a `merchandise_sales` row with `order_status='submitted'`.
- CMO's Merchandise Manager (`src/components/executive/MerchandiseManager.tsx`) exposes a status dropdown (`submitted / processing / completed / failed`) that only updates the `order_status` column — flipping to "failed" does **not** refund the agent's wallet or close the recovery plan. There is no reject / refund action anywhere.
- So today: rejecting a purchase request is **not possible** — the agent stays debited even if CMO marks the order failed.

## What to build

Add a first-class **Reject purchase request** action for CMO / Manager / Super Admin on any `merchandise_sales` row that is still `submitted` or `processing`.

Rejecting must:

1. Refund the full amount the agent already paid:
   - Instant catalog purchases (`agent_purchase_merchandise`) → reverse the ledger with a matching `wallet` `cash_in` + `platform` `cash_out` pair so the withdrawable wallet is restored.
   - Smartphone / Spiro / any credit sale with an active `merchandise_recovery_plan` → cancel the plan, refund any `amount_recovered` already swept back to the agent's withdrawable wallet via the ledger, and zero the outstanding balance.
2. Mark the sale `order_status='rejected'` (new enum value) with `rejection_reason`, `rejected_by`, `rejected_at`.
3. Emit a `system_event` (`merchandise.purchase_rejected`) and an SMS to the agent.
4. Be idempotent — a second reject on the same sale is a no-op.

## UI

In the **Sales Transactions** table:

- Add a red "Reject" button next to the status dropdown, shown only while `order_status` is `submitted` or `processing`.
- Clicking opens a small dialog: shows agent name, item, amount to refund, an explanation of what will be refunded (wallet vs recovery plan), and a required **reason** textarea (min 10 chars).
- After confirm, call the new `reject_merchandise_purchase(sale_id, reason)` RPC, toast the refunded amount, refresh.
- Rejected rows render with a muted row + a "Rejected" badge and tooltip showing reason / who / when. The status dropdown is hidden for rejected rows.

Add a "Rejected" filter chip above the sales table so CMO can review them.

## Technical

New migration:

- `ALTER TABLE merchandise_sales ADD COLUMN rejection_reason text, rejected_by uuid REFERENCES auth.users, rejected_at timestamptz;`
- Extend allowed `order_status` values to include `rejected` (loosen the CHECK constraint if one exists).
- Function `public.reject_merchandise_purchase(p_sale_id uuid, p_reason text) RETURNS jsonb`, `SECURITY DEFINER`, `SET search_path = public`:
  - Auth: caller must have `cmo`, `manager`, or `super_admin` role.
  - Lock the sale row `FOR UPDATE`; short-circuit if already `rejected`.
  - Detect refund path:
    - If a `merchandise_recovery_plans` row exists for this sale → cancel it, sum `merchandise_recovery_deductions.amount` already swept, refund that via `create_ledger_transaction` (wallet `cash_in withdrawable` + platform `cash_out debt_recovery_reversal`).
    - Else (instant purchase) → refund `total_revenue` via the same ledger shape as `agent_purchase_merchandise` but with directions inverted and `category='wallet_refund'`.
  - Update the sale row (`order_status='rejected'`, reason, actor, timestamp, `amount_outstanding=0`).
  - Insert `system_events` + `audit_logs` row.
  - Return `{ refunded, path: 'instant'|'recovery_plan', sale_id }`.
- Grant EXECUTE to `authenticated`; RLS on new columns follows the existing sales-table policies.

Frontend edits (single file):

- `src/components/executive/MerchandiseManager.tsx`: extend `OrderStatus`, add `RejectPurchaseDialog`, wire the button + filter chip, refresh queries after reject.

No other RPCs or edge functions are touched.

## Out of scope

- Automatic reject on stock-out or fraud rules — manual only for now.
- Agent-facing "your order was rejected" screen beyond the SMS + wallet reflection.
