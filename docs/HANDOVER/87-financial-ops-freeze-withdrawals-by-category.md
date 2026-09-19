# 87 — Financial Ops can freeze pending Cash Out withdrawals by category

**Built 2026-09-19. Before touching `ApprovalQueue.tsx`'s bulk-action logic, `approve-withdrawal`'s
gate order, or `withdrawal_requests.frozen`/`frozen_*` columns again.**

## What was asked

On the Financial Ops "Approval Queue" (Pending Withdrawals), Josh wanted to control liquidity by
category: e.g. see all pending Landlord Payouts, choose to pay a few now, and put the rest on hold
— even if a cashout agent has already claimed the payout and is waiting to hand over cash.

## Design

Two independent things, both new:

1. **Category filter on the Cash Out tab.** `categorizeWithdrawal()` in `ApprovalQueue.tsx` derives
   a category per pending withdrawal from the requester's enabled `user_roles.role`
   (`landlord`/`landlord_ops` → Landlord Payouts, `agent`/`senior_agent`/`sub_agent`/`agent_ops` →
   Agent Payouts, `supporter` → Supporter Payouts, `tenant`/`tenant_ops` → Tenant Payouts, everything
   else → Staff & Other), with `withdrawal_requests.landlord_payout_id IS NOT NULL` overriding role
   since that column is a definitive link to a landlord payout event. This is **display/filtering
   only** — it replaces the old hardcoded `category: 'wallet_withdrawal'` string, which nothing else
   in the file read. Filtering by category chip narrows the existing `items` list, so the pre-existing
   "select all" checkbox and bulk-action bar automatically operate on just that category — no new
   selection mechanism was needed.
2. **Freeze / Unfreeze**, a new bulk action alongside Approve/Reject. Four new columns on
   `withdrawal_requests` (migration `20260919200000_withdrawal_request_category_freeze.sql`):
   `frozen boolean default false`, `frozen_at`, `frozen_by`, `frozen_reason`, plus `frozen_category`
   (audit-only — records which category chip the operator had selected when they froze, never
   re-derived from it). Freezing/unfreezing is a direct frontend `.update()` on `withdrawal_requests`
   — not money movement, so it doesn't go through an edge function, matching how this file already
   writes `payout_code` directly. `status` is untouched by freeze/unfreeze, so a frozen item stays in
   the queue (still fetched by the existing `status in ('pending','requested')` query) instead of
   disappearing like an approve/reject does.

## The actual enforcement — one choke point, two layers

The critical requirement was "even when the agent has already withdrawn [claimed the payout]."
Both the Financial Ops approval flow AND the cashout agent's "Confirm payout" flow
(`AgentCashPayoutsTab.tsx`'s `completeWithdrawal` mutation) call the *same* `approve-withdrawal` edge
function — so that's the one place a frozen check has to live to cover both paths. Added
immediately after the function fetches the withdrawal row (`supabase/functions/approve-withdrawal/index.ts`,
right before the existing account-level fraud-freeze gate): if `wr.frozen`, log an
`withdrawal_blocked_frozen` audit row and return `403 { code: "WITHDRAWAL_FROZEN" }` with
`wr.frozen_reason` if present. Both callers already surface `error`/`message` from this function as a
toast, so no separate client-side gating was needed on the agent side.

Backstopped at the database layer the same way the existing account-level fraud gate is (see
`enforce_no_fraud_withdrawal_request`): a new `BEFORE UPDATE OF status` trigger,
`trg_enforce_no_progress_on_frozen_withdrawal` / `enforce_no_progress_on_frozen_withdrawal()`, raises
if `NEW.frozen = true` and `status` is changing to anything other than `rejected`/`cancelled`. It only
fires on an `UPDATE OF status`, so freezing/unfreezing itself (which never touches `status`) is
unaffected — an operator can still reject a frozen item directly if they decide to.

## What was deliberately left alone

- **`useLandlordPayoutsBlocked`/`treasury_controls.landlord_payouts_blocked`** — a pre-existing,
  unrelated CTO-only global kill switch that hides *not-yet-created* landlord payout requests from
  the merchant claim queue entirely. This feature is per-request, operator-driven, and reversible;
  it does not touch that flag or its enforcement points (`v_merchant_payout_queue`,
  `claim_withdrawal_verified`, `get_withdrawal_claim_status`).
- **`wallet_ops` queue / `pending_wallet_operations`** — freeze only applies to the Cash Out tab
  (`withdrawal_requests`). Wallet Ops items (portfolio top-ups, ROI payouts) have no cashout-agent
  claim step and no `frozen` column; adding it there was out of scope.
- **RequestDetailSheet.tsx** — untouched. It maps specific known fields from `rawData`; the new
  `frozen*` columns simply aren't in its field list yet, which is a display-only gap, not a bug.

## Verify this is live

```sql
-- Columns + index exist
select column_name from information_schema.columns
where table_name = 'withdrawal_requests' and column_name like 'frozen%';

-- Trigger is wired
select tgname from pg_trigger
where tgrelid = 'public.withdrawal_requests'::regclass and tgname = 'trg_enforce_no_progress_on_frozen_withdrawal';

-- A frozen withdrawal cannot be approved even by an edge-function bypass attempt
update withdrawal_requests set frozen = true where id = '<test id>';
update withdrawal_requests set status = 'completed' where id = '<test id>';
-- expect: ERROR withdrawal_frozen: ...
```

Per the standing migrations-diverge-from-production gotcha, re-run the column/trigger check above
against the live database after this migration is pushed — don't assume the push applied it.
