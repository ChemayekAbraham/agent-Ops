# Reverse today's auto-credited agent advances

## What the records show (verified now)

- 191 agent advances were created today between 05:56 and 06:00 UTC, all status `active`, none reversed.
- Principal disbursed: UGX 9,327,000. Total repayable being tracked: UGX 14,165,598.
- Each one has a matching `agent_advance_credit` ledger leg into the agent's **withdrawable** wallet (191 legs, UGX 9,327,000) — so the money did land in agent wallets.
- Recoverable right now from agent withdrawable balances: UGX 6,576,600.
  - 157 agents still hold the full principal.
  - 33 agents have a zero withdrawable balance.
  - Unrecoverable shortfall today: UGX 2,750,400 (already spent or withdrawn).

## What will be built

A **bulk reverse** action in the CFO Disbursed Advances Register, on top of the existing single-advance reversal engine — no new accounting rules.

1. **Preview step (read-only).** A dialog lists the batch to be reversed with the totals above, per-agent rows showing Disbursed / Recoverable now / Shortfall, and a filter for the batch window (today). Nothing moves until confirmed.
2. **Confirmation.** Mandatory reason (10+ characters), applied to every advance in the batch, plus a typed confirmation of the batch size.
3. **Execution.** Each advance is reversed through the existing `reverse_agent_advance` function, all sharing one clawback group id so the batch is traceable as a single event. Per advance it: claws back what the agent actually holds via CFO Direct Debit, stops daily deductions, returns the request to Waiting for Approval, and records the audit entry plus system event. Wallets are never driven negative; any uncollected part is recorded as a shortfall on the advance and in the audit trail.
4. **Result report.** After the run: number reversed, total recovered, total shortfall, and a per-agent list of shortfalls that Finance still needs to chase, exportable.

## Technical notes

- Backend: new `public.reverse_agent_advances_bulk(p_advance_ids uuid[], p_reason text)` that generates one `reversal_clawback_group_id`, loops the ids, calls the existing `reverse_agent_advance(p_advance_id, p_reason, p_clawback_amount, p_clawback_group_id)` per row inside a per-advance exception block so one failure cannot abort the batch, and returns a per-advance outcome (reversed / skipped / error, recovered, shortfall). CFO/super_admin only.
- The existing `advance_reversal_plan(p_advance_id)` supplies the authoritative Approved / Disbursed / Recovered / Amount-to-reverse figures for the preview — no manual amounts, no wallet-balance guessing.
- Existing guards stay intact: same-day window, row lock, `reversed_at` duplicate guard, so a re-run cannot double-claw.
- Frontend: `BulkReverseAdvancesDialog.tsx` next to the current `ReverseAdvanceDialog.tsx`, wired into the CFO advances register with a "Reverse today's batch" action and a selection mode on the register list.

## Not included

No change to approval routing, permissions, fee logic, or any other advance workflow. The skip-path that created these has already been closed.
