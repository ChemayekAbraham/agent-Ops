# 128 — Kalule Brian's landlord "swapped" to Ndagire Sumayiyah's: one shared landlord record (2026-09-24)

**Status: data corrected live 2026-09-24, verified. No code change.**

## Report

Josh: *"The landlord number of Kalule Brian's landlord has been swapped to the landlord of Ndagire
Summayah."*

## What was actually wrong

The landlord number itself had not changed. Both tenants (agent JAMES KATONGOLE,
`16d52ad2…`) had **all 15 of their rent plans attached to a single landlord record**,
`661c83f1…` (Gloria Nakalekwa, 0703141822). Anything done to "one tenant's landlord" happened to
both.

On 2026-09-24, between 11:41 and 12:28 UTC, JANEHEPHZIBAR GIMONO (`5295252d…`) tried to correct
Kalule's landlord by editing that shared record:
- **Name:** renamed three times to "nakasita joanita". The name change went through, because names
  are not number-locked.
- **Number:** tried three times to change it to 0750754907. The doc-120 lock blocked it each time
  and opened two change requests (`7600b58c…` phone, `5b658594…` mobile_money_number).

The result was a hybrid record: Joanita's name with Gloria's number, showing on both tenants. Had
the change requests been approved, **Ndagire Sumayiyah's landlord payouts would have gone to
0750754907**, including her UGX 1,500,000 payout already pending in the merchant queue.

## Correction (Josh confirmed: Kalule's landlord = Nakasita Joanita, 0750754907)

A new landlord row could not be inserted because `enforce_unique_landlord_phone` rejects it:
0750754907 was already the verified landlord "Joan Timo" (`d8d31630…`, Entebbe, 0 plans, 0 payouts,
verified payout number 0750754907). One guarded transaction did the following:
1. Renamed `d8d31630` "Joan Timo" → **"Nakasita Joanita"**.
2. Renamed `661c83f1` back → **"Gloria Nakalekwa"**.
3. Re-pointed Kalule's funded, not-yet-paid-out plan `2b12e1c4…` (UGX 600,000) to `d8d31630`.
4. Closed both change requests as `superseded`. Their decided_reason records why. The guard was
   opened with `landlord_numbers.change_authorized`, the same way `review_landlord_number_change`
   opens it, and only for this exit transition.
5. Wrote an `audit_logs` row (`landlord_misattachment_corrected`).

Verified after the transaction: Kalule's plan resolves to Nakasita Joanita / 0750754907. Sumayiyah's plan and her pending
withdrawal `dd3ddbdb…` are still on Gloria Nakalekwa / 0703141822.

## Not done / open

- **Kalule's three past plans were not re-pointed** (19 Aug 2.0M, 26 Aug 2.5M, 8 Sep 1.5M). Their
  payouts went to 0703141822 (Gloria). If Nakasita Joanita was his landlord all along, UGX 6.0M
  went to the wrong number. That needs a FinOps/fraud call, not a data edit.
- Before the lock existed, `661c83f1` was edited in place between at least five landlords
  (Nambi Brenda, Gloria Nakalekwa, Mafabi Zacarias, Nakagezi Betty, Kalinaki Enerst), per the
  payout snapshots. This is the doc-120 swap pattern, and the record belongs in that fraud review.
- **Landlord names are not locked.** The name change passed freely (`landlord_material_change_applied`).
  A rename on a shared or verified record can be just as misleading as a number change.
- Root cause: agents can attach a new tenant to an existing landlord record, and nothing flags
  one landlord record being shared across tenants at different addresses.

## Follow-up (same day): plan missing from the agent's Landlord Payout Float withdrawal

Josh: the corrected landlord must show on the agent's **Landlord Payout Float** withdrawal.
`AgentFloatPayoutWizard` builds that list from `agent_landlord_assignments`, which was only written
by `trg_auto_assign_landlord_on_rent_request` **AFTER INSERT**. Re-pointing the plan's `landlord_id`
therefore left James Katongole with no assignment for `d8d31630`, and the plan disappeared from his
list. `landlord-payout-disburse` doesn't read assignments, so only the screen was affected.

- **Data:** inserted the assignment (agent `16d52ad2`, landlord `d8d31630`, plan `2b12e1c4`).
  Verified: the screen's query now returns Kalule Brian → Nakasita Joanita, 0750754907, UGX 600,000,
  unpaid.
- **Code:** `20260924200000_assign_landlord_on_rent_request_landlord_change.sql` adds
  `trg_auto_assign_landlord_on_rent_request_update`, which is AFTER UPDATE OF `landlord_id` and
  `agent_id` and runs the same idempotent `auto_assign_landlord_to_agent()`. Applied live and
  verified.
- **Not backfilled:** 4 other funded, unpaid plans have no active assignment for their agent and
  landlord (`2849983b` 100k 03-01, `ac2a40b5` 500k 04-10, `75a1c591` 200k 03-26, `4b32a6db` 300k
  09-17). Backfilling would make them payable from float, so that's a human call. The March/April
  ones are probably stale.
