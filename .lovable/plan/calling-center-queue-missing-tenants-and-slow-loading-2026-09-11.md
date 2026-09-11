# Calling Center queue: missing tenants and slow loading

## What I found (traced on live data)

The Calling Center queue is **not** a live list of active tenants. It is a snapshot taken once, when the current calling round was opened on **1 Sep 2026**. Since then:

- Eligible active tenants today: **791**
- Tenants actually in the queue: **646**
- Eligible tenants that never entered the queue: **167**

Anyone whose landlord was funded after 1 Sep simply never got added. That is the root cause of "exists in All Tenants, absent from Calling Center" — nothing to do with agent assignment, tenant status or filters.

Second, separate cause for the specific name asked about: **Nazziwa Sumaia is in the queue**, on the same active plan All Tenants shows. Her row sits in the **Unreachable** state (one attempt, retry date 7 Sep). Search only looks inside the tab you are on, so searching from "To call" returns nothing and she looks missing.

Third, speed: one page of the queue currently takes **~8 seconds** and reads over a million data pages. The queue view joins every subject family — landlord summaries, the agent directory, agent advances, merchant float, agent eligibility — for every row, even when the row is a tenant. Those unrelated tables are scanned in full on every single load, on top of every tab badge count.

## The fix

**1. Keep the open round current (root cause)**
Add a top-up step for the open calling round: any tenant who is eligible now but has no row yet gets added as "To call". It only ever adds — existing rows, their state, attempts, notes, feedback and call history are never touched, so nothing is lost and nothing is duplicated (one row per tenant per round). Tenants who are no longer eligible keep their rows and history; they are not removed.

This runs when the Queue opens and is available as an explicit "Sync queue" action showing how many were added. The eligibility definition itself is unchanged — it reads the existing active-plan population exactly as today.

**2. Make search find people in any state**
Tab counts become search-aware, so typing a name shows which state the person is in (e.g. "Unreachable 1") instead of an empty list. The tab contents, filters, sorting and actions are unchanged.

**3. Speed**
Rework the queue view so each row only looks at its own subject family instead of scanning landlord, agent, advance, merchant and eligibility data for every row. Same columns, same rows, same values — only the way it is fetched changes. Target is well under a second per page.

## Verification

- Count eligible vs queued before and after the top-up; expect the gap to close to zero with no duplicate rows and no state changes on existing rows.
- Confirm the previously missing tenants appear and are searchable.
- Confirm Nazziwa Sumaia is findable by name and shows under Unreachable.
- Re-time a queue page and the tab counts before/after.

## Technical detail

- New additive migration only, all inside the `cc_*` calling spine:
  - `cc_topup_cycle(p_subject_type)` — SECURITY DEFINER, same authorization as the existing queue read, inserts missing `cc_cycle_rows` from `cc_cycle_populations.source_view` (`v_cc_tenant_calling_population`) using the same DISTINCT/priority expression as `cc_open_cycle`, `ON CONFLICT DO NOTHING` on `(cycle_id, subject_id)`; returns rows added. No deletes, no updates.
  - Add the unique guard on `(cycle_id, subject_id)` if absent, so top-up can never duplicate.
  - Replace `v_cc_call_queue` with a version whose landlord/agent/advance/merchant/eligibility joins are `LEFT JOIN LATERAL (… WHERE r.subject_type = '…' …) ON true`, so they are skipped per row instead of scanned. Column list identical.
  - `cc_state_counts` gains an optional `p_search` parameter (default null) matching `cc_call_queue_page`'s name/district predicate.
- Frontend: `useCcCallingHub.ts` (top-up on cycle load + `syncQueue` mutation, search passed to state counts) and the Queue tab in `CallingHub.tsx` / `TenantCallingCenter.tsx` for the "Sync queue" control.
- Nothing outside the Calling Center: no changes to rent plans, funding, payments, commissions, wallets, ledger, agent assignment or the active-tenant definition.
