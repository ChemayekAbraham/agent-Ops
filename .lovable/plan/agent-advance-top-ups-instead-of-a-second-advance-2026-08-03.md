# Agent Advance Top-ups (instead of a second advance)

Agents with an ongoing advance stay blocked from taking a **new** advance, but once they have repaid at least **30%** of the current advance — and are not behind schedule — they can request a **top-up** that is merged into the existing advance.

## Rules enforced

- Eligible only if: an active advance exists, repaid ≥ 30% of that advance's total payable, no arrears / not overdue, repayments at or ahead of the expected-to-date schedule, and no other request already in the pipeline.
- Top-up amount: minimum UGX 10,000, maximum **90% of the current advance principal** (never more than the current advance).
- The top-up inherits the current advance's rate (monthly rate) and repayment frequency — no re-pricing.
- The agent specifies how many extra days to extend by; the schedule extends by exactly those days.
- Access fee on the top-up is charged at the inherited rate over the extension days; registration fee is not re-charged.
- After merge, daily/period installment and total outstanding are recalculated from the merged figures.

## How the merge works

```text
Existing advance:  principal P0, total payable T0, outstanding O0, rate r, freq f, cycle C0
Top-up:            amount A, extension days D
Top-up access fee: A * ((1+r)^(D/30) - 1)
New principal:     P0 + A
New outstanding:   O0 + A + topup access fee
New cycle days:    C0 + D        expires_at: +D days
New installment:   remaining outstanding / remaining installments (recomputed)
```

## Work items

**Database**
- Add to `agent_advance_requests`: `request_kind` ('new' | 'topup', default 'new'), `parent_advance_id`, `extend_days`.
- New RPC `agent_advance_topup_eligibility(p_agent_id)` returning: active advance id, principal, total payable, repaid amount and percent, expected-repaid-to-date vs actual (behind/on-track), inherited rate + frequency, `max_topup` (90% of principal), eligible flag and human-readable block reason.
- Update trigger `enforce_no_double_agent_advance` so it allows a request when `request_kind = 'topup'` **and** the eligibility RPC passes, and still blocks plain new requests and duplicate pipeline requests.
- New RPC `apply_advance_topup(p_advance_id, p_amount, p_extend_days, p_request_id)` — security definer, staff/system only: validates eligibility again, updates `agent_advances` (principal, access_fee, outstanding_balance, cycle_days, expires_at, installment_amount, status back to `active`), inserts the `agent_advance_topups` audit row, and returns the recalculated figures.

**Disbursement path**
- `src/lib/disburseAgentAdvance.ts`: when the request is a top-up, call `apply_advance_topup` instead of inserting a new `agent_advances` row; wallet credit + platform ledger legs stay the same (amount = top-up amount), and the SMS says "top-up" with the new daily amount and new end date.

**UI**
- `src/components/agent/AgentAdvanceRequestForm.tsx`: when the agent has an active advance, the menu shows **Request Top-up** in place of the blocked "New advance" path. The top-up form shows current advance summary (repaid %, outstanding, rate, frequency), amount input capped at 90% of principal, extension-days input, live preview of new outstanding / new installment / new end date, and reason. If not eligible, an explanatory panel states why (below 30% repaid, or behind on payments) with the exact figures.
- Ops/CFO queues (`AdvanceRequestsQueue`, `CFOAdvanceRequestPayments`) get a "Top-up" badge plus parent-advance context so approvers know it merges rather than creates.

**Recalculation safety**
- Daily deduction sweep (`sweep_agent_advance_recovery`) already reads `installment_amount`, `repayment_frequency` and `outstanding_balance`, so it picks up merged figures with no change; the plan re-verifies this after the merge RPC lands.
