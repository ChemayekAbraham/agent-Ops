# 120 — Six-eyes staff requisition approval: COO → CEO → CFO (2026-09-24)

**Status: built and committed. NOT live yet.** The migration was dry-run against production inside a
transaction that rolled back (all 12 guard checks behaved correctly, results below). Deploy order
matters: **deploy the three edge functions first, then apply the migration** (see "Deploying").

## Request

Josh (item 8): nobody can approve a requisition alone. It takes three people and six eyes, in the
order COO → CEO → CFO. Other staff can see a requisition in flight but can't approve it. This
closes the path where a requisition goes straight to the CFO.

## What was wrong (verified live)

Before this change, "nobody reviews their own money" was handled by **skipping stages**, not by
checking who the person was:

| Path | Old route | Distinct approvers |
|---|---|---|
| Ordinary staff | (dept head) → COO → CFO | 2 (no CEO) |
| Requester holds **COO** | **straight to CFO** | **1** |
| Requester holds CFO | COO → CEO | 2 (no CFO) |
| Growth-commission claim | CEO → CFO | 2 (no COO) |
| Any `super_admin` / `manager` (17 people) / CEO | could approve **any** stage | 1 |
| `manager` / `super_admin` | could approve **their own** requisition | 0 |

Role checks alone can't enforce this, because **Joshua Wanda and Benjamin Muhanguzi each hold CEO +
CFO + COO**, and Angwen Sarah holds CFO + COO. Under role-only checks, one of them could have signed
every stage.

**Two requisitions went through the hole this morning, before the fix.** Both were credited at
06:44 UTC on 2026-09-24:
- **SRQ-00148**: PIUSLUBEGA SSENKALI (COO), UGX 93,000. It had **one** signer: Angwen Sarah as CFO.
  No COO or CEO signed.
- **SRQ-00145**: Keith Asea, UGX 580,000. LUKODDA JOSEPH signed as COO and Angwen Sarah as CFO.
  No CEO signed.

Both are credited and I left them alone. Whether to re-review them is Josh's call.

## What was built

### Database (`supabase/migrations/20260924130000_six_eyes_staff_requisition_approval.sql`)
- **`staff_requisition_route(_user_id)`**: every route now ends at `final_stage = 'cfo'` and never
  skips a stage. A requester who holds COO still starts at the COO stage, and a *different* COO
  signs it. The department-head stage is still skipped when the requester is that head, as before.
- **`staff_requisition_six_eyes_guard` trigger** (BEFORE INSERT OR UPDATE, only for
  `request_kind = 'requisition'`). This guarantee holds no matter what the edge function does:
  - INSERT: forces entry at `supervisor` or `coo` with `final_stage = 'cfo'`, and clears every
    `*_decided_by` field, so a caller can't pre-sign a row or start it at the CFO.
  - Only these stage changes are legal: supervisor→coo, coo→ceo, ceo→cfo, cfo→approved. Any open
    stage can go to rejected or returned. Two special cases: approved→cfo is allowed only as the
    decide function's rollback after a failed wallet credit, and returned→(resubmission) has its
    own rules (below).
  - Each sign-off runs through **`staff_requisition_assert_signer`**, which requires that the signer
    is present, is not the requester, is **a different person from every earlier signer**
    (department head included), and **holds the role** they signed as (`has_role`).
  - cfo→approved re-checks all three sign-offs together.
  - An approver can **lower** `approved_amount` but can't raise it above what earlier signers saw.
  - A resubmission that **raises the amount** has to restart the chain with its sign-offs cleared.
    Otherwise it goes back to the stage that returned it (or to the start).
- **In-flight rows are re-routed** back to their first missing sign-off, with a `rerouted` event.
  Nothing currently qualifies, because the two target rows were credited first.
- **`staff_requisition_events_action_check`** gains `rerouted` and `amount_reduced`. The
  `amount_reduced` value was already written by `staff_requisition_reduce_amount()` but was never in
  the check, so **that RPC could never have succeeded**. This fixes it as a side effect.

### Edge functions
- **`staff-requisition-decide`**:
  - Approving an ordinary requisition requires the **current stage's own role**. The CEO, manager
    and super_admin overrides can still **decline or send back** at any stage, because stopping
    money needs no quorum, but they can no longer approve.
  - Self-decision is now blocked for managers and super_admins too.
  - The function refuses anyone who signed an earlier stage (`same_approver_blocked`).
  - Stages advance strictly supervisor→coo→ceo→cfo, and the final approval is always at the CFO.
  - It refuses to raise the amount (`amount_above_prior_approval`).
  - Every stage write is now conditional on `stage = <stage read>`, so two approvers clicking at
    once can't double-advance. The loser gets a 409 `stage_changed`. A refusal from the database
    guard comes back as a readable 409 instead of being silently ignored. (The old code ignored
    update errors on non-final stages, so it would have reported "now with X" even when the row
    hadn't moved.)
  - Staff loans and facilitation keep their old behaviour.
- **`staff-requisition-submit`**: the fallback for staff with no department no longer sends a COO's
  own request straight to the CFO. A resubmission that raises the amount clears the sign-offs and
  restarts approval.
- **`growth-commission-claim`**: claims now enter at the COO (previously CEO) and notify COO holders.

### Frontend (logic only, no markup)
- `StaffRequisitionQueue.tsx` `isMine`: for ordinary requisitions, a row sits in "Awaiting my
  review" only if I hold the current stage's role **and** didn't sign an earlier stage. Everyone
  else sees it read-only under "In flight", which is how other staff "see without approval rights".
  RLS already let every staff member read all rows. The CEO / manager override stays for other
  request kinds.
- `me/Requisitions.tsx`: the route line now shows COO → CEO → CFO. The old stage order would have
  hidden the CEO stage.

## Not changed
- **Staff loans** (`staff_loan_chain_guard`): HR → CEO → CFO disbursement, already three different
  people.
- **PSO facilitation** (`pso_facilitation_guard`): one named approver plus a named disburser, two
  people. That was a deliberate design on 2026-09-21. Ask Josh if it should become six-eyes as well.
- Agent requisitions (`requisition-decide`), merchant float requisitions, and the retired director
  and employee-link flows.

## For Gemini (UI copy)
- `AgentsSpacePanel.tsx` (around lines 1045 and 1686) still says "Agent Ops → COO → CFO" /
  "Next Approver: COO → CFO". It should read "→ COO → CEO → CFO".
- `StaffRequisitionQueue.tsx` `routeNote` still prints "CFO review skipped" for legacy rows, which
  is correct for old rows. Consider adding a "Six-eyes: COO → CEO → CFO" line on new ones.
- The CEO no longer sees Approve/Decline on COO- or CFO-stage requisitions (read-only). The server
  still accepts a CEO *decline* at any stage if a separate decline-only control is wanted.

## Operational notes
- A stage can stall if every holder of its role has already signed. For example, when Joshua
  requests: CEO must be Benjamin, CFO must then be Angwen or Bayo, and the COO can't be whoever
  signs CFO. Today every combination still has at least one eligible person, but if the CEO role
  drops to one holder, that CEO's own requisitions can't be approved.
- The CFO stage still also needs `isCfoApprover` (unchanged).

## Dry-run results (production, rolled back)
Insert asking for `cfo`/`final ceo` was coerced to `coo/coo/final cfo`. Each of these was blocked:
the requester signing COO, COO→CFO skip, the same person signing COO then CEO, a non-CEO signing
CEO, raising the amount, and the same person signing CEO then CFO. The three-person chain (Joshua
COO → Benjamin CEO → Bayo CFO) was approved. The credit-failure rollback and decline were allowed.

## Deploying
1. Deploy `staff-requisition-decide`, `staff-requisition-submit` and `growth-commission-claim`.
2. Then apply the migration. If you apply it first, the old decide code sends coo→cfo, the guard
   refuses it, and the old code ignores the error and tells people it moved on.
3. Verify: `select tgname from pg_trigger where tgname='staff_requisition_six_eyes_guard_trg'`, and
   check that `staff_requisition_route` no longer contains `v_final := 'ceo'`.
