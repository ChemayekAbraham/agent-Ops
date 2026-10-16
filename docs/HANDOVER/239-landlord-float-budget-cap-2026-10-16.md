# 239 — Landlord float budget cap (COO → CFO), 2026-10-16

Branch: `dev/landlord-float-cap`. Backend and data logic are done (Claude). **The screens are Gemini's**; this
note is the contract for them.

## What it does

The CFO sets a **daily** and a **weekly** landlord float budget. At the COO step, the COO can forward rent requests
to the CFO only while their `rent_amount` fits in the room left. Room left is the smaller of what's left today and
what's left this week.

- No daily or no weekly budget for today means COO approvals are blocked.
- A request that doesn't fit stays at the COO step. The COO can ask for a **miscellaneous** approval, with a
  reason per request (at least 10 characters). Only the designated CFO can approve it. Once approved, the request
  moves to the CFO stage outside the cap.
- If a daily budget is above the weekly one, the CFO gets a warning. They can still save, but only with a reason.
- The CFO can change a budget mid-period. If what's already approved ends up above the new budget, the CFO and COO
  are both notified with the excess. Nothing already approved is blocked.
- A CFO rejection at the disbursement step now **returns the request to the COO**, not to the agent. Its amount goes
  back into the budget.
- Days and weeks follow Kampala time; weeks run Monday to Sunday. Each period resets on its own.
- History is kept: every budget (superseded ones too) and every approval made against it.

**Accounting:** this is a budget control, not a money movement. Nothing posts to `general_ledger`, and no CoA mapping
or allowlist changes. It measures `rent_amount`, which is the same amount `fund-agent-landlord-float` funds.

**Access**
- Reading: users with the `coo` or `cfo` role.
- Setting budgets, deciding miscellaneous asks, returning requests to the COO: the designated CFO only
  (`is_cfo_approver`).
- Approving at the COO step: the `coo` role. This replaces the earlier `super_admin` allowance.

## Database (migration `20261016160000_landlord_float_budget_cap.sql`)

**Tables** (read-only for COO/CFO through row-level security; all writes go through the functions below):
- `landlord_float_budgets`
- `landlord_float_misc_requests`
- `landlord_float_budget_allocations`

**Functions**

| Function | Who | Does |
|---|---|---|
| `get_landlord_float_budget_status(p_day?)` | COO, CFO | Position for the day, plus `can_*` flags and pending miscellaneous asks |
| `cfo_set_landlord_float_budget(type, amount, reason?, start?)` | CFO approver | Sets or replaces a budget. `OVER_WEEKLY_REASON_REQUIRED:` error when a reason is needed |
| `coo_approve_rent_requests(ids[], comment?)` | COO | Batch approve within the room. Returns `approved / over_cap / skipped / status` |
| `coo_approve_rent_request(id, comment?)` | COO | Single-request form; raises `OVER_BUDGET:` / `NO_BUDGET:` |
| `coo_request_landlord_float_misc([{rent_request_id, reason}])` | COO | Asks the CFO to approve above the cap |
| `cfo_decide_landlord_float_misc(ids[], 'approve'\|'reject', note?)` | CFO approver | A reject needs a note |
| `cfo_return_rent_requests_to_coo(ids[], reason)` | CFO approver | CFO step back to the COO step; releases the budget |
| `get_landlord_float_budget_history(type?, limit?)` | COO, CFO | Budgets with used / misc / excess per period |
| `get_landlord_float_budget_allocations(type, start)` | COO, CFO | Approvals against one day or week, with names |
| `get_landlord_float_misc_queue(status?, limit?)` | COO, CFO | Miscellaneous asks with tenant, landlord, agent and who asked |

**Triggers**
- A trigger refuses a direct `partner_ops_approved → coo_approved` write, so the cap can't be bypassed.
- A second trigger releases the allocation whenever a request moves back before the COO step, and re-measures it
  when `rent_amount` changes.

**Verified:** dry-run against production inside a rolled-back transaction, covering 15 scenarios (blocked,
over-cap, guard, miscellaneous ask and approve, CFO return, reason rule, excess, rent edit, access denial). Nothing
was kept.

## Frontend hooks (ready to use)

From `src/hooks/useLandlordFloatBudget.ts`:
- `useLandlordFloatBudgetStatus()`
- `useLandlordFloatBudgetHistory()`
- `useLandlordFloatBudgetAllocations()`
- `useLandlordFloatMiscQueue()`
- `useLandlordFloatBudgetActions()`, which returns `{ setBudget, approveAtCoo, requestMisc, decideMisc, returnToCoo }`

Pure helpers and types live in `src/lib/landlordFloatBudget.ts`:
- `fitsLandlordFloatBudget`
- `partitionByLandlordFloatRoom`
- `landlordFloatExcess`
- `landlordFloatErrorCode` / `landlordFloatErrorText`
- `summarizeCooApproval`

**Already wired (logic only, no JSX change)**

In `RentPipelineQueue.tsx`, at the COO step:
- Quick approve, sheet approve and bulk approve all call the budget-aware RPC. Bulk approve goes oldest first, in
  one call.
- COO return uses `coo_return_rent_request`. The old path failed with "Invalid stage".

In `RentPipelineQueue.tsx`, at the CFO step:
- Reject is now return-to-COO.

The component also exposes, for the UI:
- `landlordFloatBudget` (the status query)
- `requestFitsLandlordFloatBudget(req)`
- `requestLandlordFloatMisc(items)`

`RentDisbursementQueue.tsx`:
- Reject is now return-to-COO.
- Exposes `landlordFloatBudget` and `landlordFloatOver` for the banner.

## Gemini: screens to build

**CFO dashboard**
1. **Budget setter.** Daily and weekly amount inputs; show today's and this week's current values and who set them.
   If the daily is above the weekly (`status.weekly.amount`), show a warning and a required reason field before
   saving. Calls `setBudget`.
2. **Miscellaneous approvals.** List from `useLandlordFloatMiscQueue('pending')`, showing the reason, tenant,
   landlord, amount and room at the time of the ask. Approve, or reject with a note (10+ characters), through
   `decideMisc`. Bulk select works.
3. **Budget history.** `useLandlordFloatBudgetHistory()`. Superseded rows are marked `is_current = false`. Drill
   into a period with `useLandlordFloatBudgetAllocations`.
4. **Over-budget banner** on the disbursement queue, when `landlordFloatOver.any`: "Exceeds the daily/weekly
   landlord float budget by UGX X".
5. **Reject wording** on the disbursement queue: change it to "Return to COO".

**COO dashboard (existing `RentPipelineQueue` at `partner_ops_approved`; show these at that stage only)**
1. **Budget bar** above the queue: today's budget, used, misc, left, and the week's left (`room`). If `blocked`, show
   "Waiting for the CFO to set today's/this week's budget".
2. **Approve buttons:** disabled when `!requestFitsLandlordFloatBudget(req)` or when the budget is `blocked`. The
   server re-checks either way.
3. **"Request miscellaneous" action** on cards that don't fit: a reason field (10+ characters), then
   `requestLandlordFloatMisc([{ rentRequestId, reason }])`. Show "Waiting for CFO" when `status.pending_misc`
   contains the request.
4. **The same over-budget banner** when `daily.excess` or `weekly.excess` is above zero.

**Copy rules:** say "Rent Plan" (never "loan"), "Supporter", and "Returns".

## Before it goes live

1. Apply the migration. Lovable regenerates `types.ts`; until then the hook calls the RPCs untyped.
2. **The CFO must set today's and this week's budgets before the COO can approve anything.** Tell ops before
   deploying, otherwise the COO queue stops on day one.
