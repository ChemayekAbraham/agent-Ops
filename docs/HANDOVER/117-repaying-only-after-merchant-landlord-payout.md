# 117 — A tenant goes on "repaying" only after the merchant pays the landlord

**Built and applied live 2026-09-24 (migration `20260924100000_gate_repaying_on_merchant_landlord_payout.sql`).
Before adding any new code path that sets `rent_requests.status = 'repaying'`, or if a plan looks
"stuck on funded" after a collection.**

## What was asked

Josh, 2026-09-24: the tenant should be put on status REPAYING only when the agent's landlord payout
withdrawal is marked completed and paid out by the merchant agent.

## What was found

The landlord payout lifecycle (live):

```
OTP verified → landlord-payout-disburse creates a withdrawal_requests row (landlord_payout_id)
  → landlord_payouts.status = 'pending_merchant_payout'
  → merchant pays, marks the withdrawal 'completed'
  → trigger advance_landlord_payout_on_withdrawal_completion → landlord_payouts 'awaiting_agent_receipt'
  → agent uploads receipt → 'completed'
```

Nothing tied `rent_requests.status` to this. Four writers moved a plan into `repaying` on the
**first collection**, with no landlord check at all:

| Writer | Transition |
|---|---|
| `agent_allocate_tenant_payment_internal` (RPC) | funded/disbursed/approved → repaying |
| `settle_tenant_rent_from_deposit` (RPC) | same |
| `guard_rent_request_agent_updates` (BEFORE trigger) | coerces agent allocation updates into repaying |
| `supabase/functions/agent-deposit/index.ts:101` | direct service-role `.update({status})` |
| `src/components/agent/TenantProfileView.tsx:746` | rejected → repaying (restore button) |

The only existing protection (doc-referenced `hasDisbursementEvidence`, `v_rent_plan_schedule`,
migration `20260912150000`) gates the *daily bill / OWING display*, not the status, and it passes
when a plan has no allocation row at all.

Live at time of fix: 31 `funded` plans whose landlord **had** been paid by the merchant but were
never promoted (no collection yet), and repaying plans without merchant evidence (listed below).

## What was done

Gated at the table so every writer (current and future) is covered:

- **`rent_request_landlord_paid_by_merchant(rr_id)`**: true only when a `landlord_payouts` row for
  the plan is `awaiting_agent_receipt`/`completed` **and** its `withdrawal_requests` row is
  `completed`/`paid`. Both are required. One live payout is `failed` while its merchant withdrawal
  says `completed`.
- **`zz_gate_repaying_on_merchant_landlord_payout`** (BEFORE UPDATE with a `WHEN` clause, not
  `UPDATE OF status`, and named `zz_` so it runs after the other BEFORE triggers that coerce status):
  - automatic transitions (funded/disbursed/approved → repaying) are **held**: the status stays as
    it was, the collection itself still lands, and an `audit_logs` row
    `repaying_held_no_merchant_landlord_payout` is written. Collections must not fail because the
    landlord hasn't been paid yet.
  - rejected → repaying (a human pressing restore) **raises** `check_violation` with a clear message,
    so the UI doesn't report a silent no-op as success.
  - exempt: `registration_type = 'outstanding_balance'` (never pays a landlord on-platform) and
    `completed → repaying` (reversal re-opening a plan that was already repaying).
- **Promotion**: AFTER triggers on `landlord_payouts` (→ awaiting_agent_receipt/completed) and on
  `withdrawal_requests` (landlord payout → completed/paid) call
  `promote_rent_request_on_merchant_landlord_payout`, which moves funded/disbursed/approved →
  repaying once full evidence exists. Both sides are watched because approve-withdrawal and the
  existing trigger update them in either order; whichever lands second sees full evidence. A
  failure inside the promotion is caught and logged (`repaying_promotion_failed`), so it can never
  roll back the merchant's payout completion.
- **Backfill**: the 31 funded-but-merchant-paid plans were promoted (audit rows
  `repaying_backfill_merchant_landlord_paid`).

Verified live, inside transactions that were forced to roll back:
- funded → repaying on an unpaid plan: status stayed `funded`;
- rejected → repaying on an unpaid plan: raised the message above;
- merchant marking a pending landlord-payout withdrawal `completed`: payout → `awaiting_agent_receipt`,
  plan `funded` → `repaying`.

## Left for a human decision: repaying plans without merchant evidence

These were **not** demoted. Changing a live plan's status touches collections and receivables, so
that is Finance's decision.

- **112 `outstanding_balance` plans**: correct, exempt by design.
- **85 plans (May–June) paid via the retired FinOps-direct path**: payout `awaiting_agent_receipt`/
  `completed` with no merchant withdrawal. The landlord was paid; there just wasn't a merchant step.
  The path has been unused since 2026-06-25. Arguably fine.
- **~76 older `normal` plans (Feb–June) with no `landlord_payouts` row at all**: they predate the
  payout table.
- **Recent, genuinely unevidenced** (created ≥ July, or only failed payouts):

| rent_request | created | tenant | payout evidence |
|---|---|---|---|
| 7a02c339-2538-42cf-9ef2-2f1950dfde18 | 09-08 | SMALLS Ronald Musana | none; allocation cancelled |
| 19a88596-9fb6-474b-b7bc-e5e3dd1dcd46 | 09-08 | Nakayiza Topister (renewal) | none; allocation open |
| 2d87245d-5f8d-4907-ab08-11eac0064e34 | 08-20 | Ssemaganda Patrick | none; 3 allocations cancelled |
| e64fabdb-1ad0-4736-ae65-08c2dde22ecd | 08-19 | Test Tenant Katusiime | none (test row) |
| ba1e9b60-36ac-479a-8f2c-18b5a690bbec | 08-06 | Lubwama Alex | none; allocation open |
| 01497e18-2ec8-4887-bd9e-b408c5a06c85 | 05-11 | Nakasinde Harriet | only a `failed` payout |

## What not to do

- Don't "fix" a plan held on `funded` by setting it to repaying by hand. Get the landlord payout
  completed by the merchant and the promotion trigger will do it.
- Don't add `UPDATE OF status` to the gate trigger. `guard_rent_request_agent_updates` changes
  status on statements that never name the column, and the gate would miss them.
- `agent-deposit` still writes `rent_requests` directly from an edge function instead of an RPC.
  The gate covers its status write, but the direct write itself is a separate, pre-existing smell.
