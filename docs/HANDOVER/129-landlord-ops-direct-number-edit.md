# 129 — Landlord Ops may edit verified landlord numbers directly, and every edit is flagged (2026-09-24)

**Status: applied live 2026-09-24 and verified.** The rolled-back behaviour test passed 4/4, the doc-120
acceptance suite passed 9/9, and the drift baseline matches with 0 open alerts.

## Request

Josh: *"Allow landlord ops to edit the number, but it is a great issue that needs to be addressed."*
The doc-120 lock (`lock_verified_landlord_numbers`) blocked everyone and pushed every number change
through the 4-stage chain. Landlord Ops now edits directly, and every such edit is treated as a
serious event.

## Behaviour now (`lock_verified_landlord_numbers()`)

| Who | Effect |
|---|---|
| Enabled `landlord_ops` role | The number is **applied**. If it is the payout number (`mobile_money_number`, or `phone` when no MoMo number is on file), `verified_mobile_money_number` moves too (source `landlord_ops_direct_edit`). `enforce_landlord_payout_eligibility` pays only that column, so without this the edit would silently keep paying the old number. The edit is also written to `landlord_number_audit` (`landlord_ops_direct_edit`) and to the **`landlord_number_direct_edits`** review queue. |
| Everyone else, including service role | No change from doc 120: the edit is reverted and a change request is opened at the service-centre stage. |
| **Everyone** | **Hard stop:** the new number may not already belong to another landlord (phone, MoMo or approved number). The trigger raises a clear error telling ops to attach the plan to that landlord instead. That was the doc-128 failure: Kalule Brian's landlord was being re-numbered onto another verified landlord's number, on a record shared with a different tenant. The attempt is audited as `direct_edit_blocked_duplicate`. |

### Risk flags on each queue row

- `shared_across_tenants`: more than one tenant has plans on this landlord record, so the edit redirects all of them.
- `open_landlord_payouts`: the landlord has payouts in `otp_verified`, `pending_merchant_payout`, `pending_finops_disbursement` or `disbursing`. Withdrawals already queued keep their own snapshot of the number.
- `repeat_edit_30d`: the record already had a direct edit in the last 30 days.
- `payout_number_changed`: the edit changed where money goes.

### Review

`review_landlord_number_direct_edit(edit_id, outcome, note)` is for CTO / CEO / COO / super_admin.
- Outcomes: `confirmed_legitimate`, `suspicious`, `reverted`.
- The note must be at least 10 characters.
- A reviewer cannot review their own edit.
- Each review is audited.

RLS lets cto, ceo, coo, cfo, super_admin and landlord_ops read the queue. There are no write policies.

## Test evidence

Run against production inside a transaction that rolled itself back:
- **Landlord-ops edit (Nakasita Joanita's phone):** applied, approved number moved, one queue row flagged
  `payout_number_changed`.
- **Landlord ops setting Gloria's record to that number:** blocked (duplicate).
- **Landlord ops on Gloria's shared record:** applied, flagged
  `shared_across_tenants, open_landlord_payouts, payout_number_changed`.
- **Plain agent:** reverted, and a change request was created.
- `supabase/tests/landlord_number_lock_acceptance.sql` passed 9/9.

The first run also caught a real bug (`text[] || 'literal'` is parsed as an array literal), and it was
fixed before any live use.

## Still open

- **No review UI yet:** the `landlord_number_direct_edits` queue, a badge on CTO/CEO overview, and
  RPC calls from the UI are Gemini's work. Until that exists, query the table.
- **11 enabled landlord_ops users**, including the person behind the doc-128 edits and Josh. If that
  is broader than intended, trimming the role list is the real lever.
- Landlord **names** are still not locked (doc 128).

## Files

- `supabase/migrations/20260924210000_landlord_ops_direct_number_edit.sql`, which includes the
  critical-function re-baseline.
