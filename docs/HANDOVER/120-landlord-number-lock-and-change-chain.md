# 120 — Verified landlord numbers are locked; changes go through a four-stage chain

**Built and applied live 2026-09-24. Acceptance tests were written first. They ran red on
production before the fix (AT1 FAIL, AT3 FAIL) and 9/9 green after it, inside a transaction that
rolls back.** This builds on doc 112, which made payouts pay only `verified_mobile_money_number`.
Doc 112 froze the approved number but left the raw number editable. That left a way to launder a
swapped-in number into the approved slot.

## What was reported

CEO, 2026-09-23 meeting, marked P0: landlord phone numbers change after they have been submitted and
approved. In Josh's own example, by the time he reached the person withdrawing, the number had
changed. The CEO asked for three things:

- Once a number has passed the chain (service centre → tenant ops → agent ops → landlord ops), an
  agent must not be able to change it.
- Withdrawals must resolve to the approved record.
- A new number must re-enter the chain from the start. This must be enforced at the database, with
  an audit row on every transition.

The concern is fraud: agents withdrawing to numbers they swapped in.

## What was found (live, 2026-09-24)

- **Anyone with a path to `UPDATE landlords` could change a verified landlord's `phone` or
  `mobile_money_number`:**
  - RLS "Agents can update managed landlords" (registering or managing agent)
  - RLS "Tenants can update own landlords"
  - `ops_update_landlord` and `EditLandlordDialog`
  - `agent_resubmit_rent_request`, which overwrites `phone` with no audit
  - service-role writers

  The only guard, `guard_landlord_agreement_backed_changes`, *logs* these changes and says in its
  own audit text that it "never blocks".
- **Scale:** from 09-09 (when that logging began; before then there is **no record at all**) to
  09-23, there were **124 phone/MoMo changes on 105 verified landlords**:
  - 36 by agents
  - **87 by an unattributed service-role writer** (`auth.uid()` NULL), spread through the working
    day and touching `mobile_money_number` only
  - 1 by anyone else

  No edge function in the repo rewrites these columns, so the writer is outside the repo. It is
  **not identified**. The lock now stops it too, and every attempt it makes lands in the audit
  table with `actor = NULL`, so its next attempt will show up.
- **How a swapped number gets laundered:** doc 112's `set_landlord_verification()` snapshots the
  *current* `mobile_money_number` on any ad-hoc re-verification. So an agent changes the number, and
  the next time anyone clicks "verify", the swapped number becomes the approved number.
- **The chain could be bypassed in one click:** the "Request change from Landlord Ops" flow
  (`AgentFloatPayoutWizard` → `landlord_verification_requests`) let a single Landlord Ops approval
  put a **new** number straight into the approved slot, skipping service centre, tenant ops and
  agent ops.
- **Two verification paths set no approved number:** pipeline auto-verify
  (`sync_landlord_verified_on_pipeline_approval`) and `service_mark_landlord_verified` both verified
  landlords with a NULL approved number. This fails safe (payout blocked) but is inconsistent.
- **Exposure, as leads and not proven fraud:** since 09-09, 119 `landlord_payouts` rows
  (UGX 43.65M) went to 88 landlords *after* their number had been changed.
  - 22 of those payouts (UGX 11.89M) followed an agent's change.
  - 39 went to a phone that differs from the landlord's current approved number. These are mostly
    pre-doc-112 payouts to raw numbers.

  Query below. Most changes are probably genuine corrections, and someone has to review the list.
  Don't auto-reverse anything.

## What was fixed — migration `20260924090000_landlord_number_lock_and_change_chain.sql`

| Piece | What it does |
|---|---|
| `trg_ab_lock_verified_landlord_numbers` (BEFORE UPDATE OF phone, mobile_money_number) | If the landlord is verified or has an approved number, **every** direct change (agent, tenant, ops, service role) is reverted. It then writes a `direct_edit_blocked` audit row with old and new values and the actor, and a valid new number becomes a change request. Formatting-only changes (`0772…` vs `+256772…`) are ignored. The trigger name sorts right after `trg_aa_landlord_verification_gate`, so the agreement-backed guard sees the reverted value and doesn't log a phantom change. |
| `landlord_number_change_requests` | `pending_service_centre → pending_tenant_ops → pending_agent_ops → pending_landlord_ops → approved`, or `rejected`/`expired`/`superseded`. There is one open request per landlord and field, and it expires after **7 days**. `risk_flags`: `matches_requester_phone`, `matches_an_agent_phone`, `used_by_other_landlord`. |
| `request_landlord_number_change(landlord, field, new, note)` | An explicit way to submit a new number. Allowed for the registering or managing agent, the tenant, ops editors and service centre reviewers. |
| `review_landlord_number_change(request, 'approve'/'reject', comment)` | The **only** path that applies a number. Each stage has a role gate: service centre = `is_service_center_reviewer` or the requester's service centre manager; then `tenant_ops`, `agent_ops`, `landlord_ops` (`coo`/`super_admin` can fill in at any stage). Four **distinct** people are required, and the requester can't review. A comment of at least 10 characters is required. An expired request is marked `expired` and refused. After the final approval, it writes the number and, when that number is the payout number, moves `verified_mobile_money_number` too (source `number_change_request`). |
| `guard_landlord_number_change_request` | Request rows only move forward along the chain, only inside the RPCs. Number, landlord and requester are immutable, terminal rows are frozen, and rows can't be deleted. |
| `landlord_number_audit` | Append-only: UPDATE and DELETE raise. An AFTER trigger writes one row per request transition, so auditing is structural rather than a convention. The review RPC adds an `applied` row with old and new value and the actor. |
| `set_landlord_verification` | For a landlord that already has an approved number, it keeps that number. A different phone on a pending verification request becomes a chain change request (`request_source = 'verification_request'`) instead of replacing it. Its result includes `number_change_request_id`. |
| `landlord_verification_gate` | Any transition **to** verified snapshots the approved number if the caller didn't, which fixes pipeline auto-verify and `service_mark_landlord_verified`. Any transition away clears it. |
| `trg_enforce_agent_landlord_payout_approved_number` | The legacy `agent_landlord_payouts` table (0 rows in 30 days, still reachable from `AgentLandlordPayoutFlow.tsx`) now gets the same approved-number gate that `landlord_payouts` has. |
| cron `expire-landlord-number-change-requests` | Hourly at :17, calls `expire_landlord_number_change_requests()`. |
| `critical_function_baselines` | Adds five functions: the lock, review RPC, request guard, gate, and `set_landlord_verification`. Re-baseline in the same migration if you deliberately change one. |

**Edge function `issue-landlord-payout-otp` (committed, NOT yet deployed):** the OTP challenge,
OTP SMS and OTP event now carry `verified_mobile_money_number` verbatim instead of the raw
`mobile_money_number || phone`. The normalized "changed since approval" check is kept.

This fixes two things:
- It makes the withdrawal resolve to the approved record end to end, since
  `landlord-payout-disburse` pays the challenge's phone.
- It fixes a false failure: the `landlord_payouts` trigger compares numbers **exactly**, so a raw
  `+256…` against an approved `0…` passed the OTP step and then failed at insert.

Until this is deployed, the DB trigger still guarantees the payout phone equals the approved number.
The only effect of the old code is that false failure.

## Acceptance tests — `supabase/tests/landlord_number_lock_acceptance.sql`

The whole file is one DO block that always ends in `RAISE EXCEPTION`, so it rolls back and is safe
against production. It impersonates real users via the JWT claims and picks fixtures live: a
verified landlord plus four distinct stage reviewers. Payout probes run between 06:00 and 22:00 EAT
and are skipped outside that window.

| # | Asserts | Before | After |
|---|---|---|---|
| AT1 | Agent and service role cannot change a verified number | **FAIL** (agent overwrote MoMo and phone) | PASS |
| AT2 | Withdrawal resolves to the approved number (a swapped number is refused, the approved one passes the phone gate) | PASS (doc 112) | PASS |
| AT3 | A new number creates a change request at `pending_service_centre` | **FAIL** (no mechanism) | PASS |
| AT4 | An unapproved number can't be paid, even with 3 of 4 stages done | n/a | PASS |
| AT5 | The full chain applies the number, the old number is no longer payable, the new one is | n/a | PASS |
| AT6 | Every change writes an audit row (6 on a chained request: created + 4 stages + applied); blocked edits are audited; audit rows can't be updated or deleted | n/a | PASS |
| AT7 | A rejected approval can't be used | n/a | PASS |
| AT8 | An expired approval can't be used | n/a | PASS |
| AT9 | Requester can't approve; one person can't approve two stages | n/a | PASS |

Re-run it after any change to the functions above.

## Exposure query (for the fraud review)

```sql
with ch as (
  select a.record_id::uuid landlord_id, min(a.created_at) first_change,
         bool_or(has_role(a.user_id,'agent')) by_agent
  from audit_logs a
  where a.action_type='landlord_material_change_applied'
    and (a.metadata->'fields' ? 'phone' or a.metadata->'fields' ? 'mobile_money_number')
  group by 1)
select p.created_at, p.id, p.landlord_id, l.name, p.amount, p.landlord_phone,
       l.verified_mobile_money_number, p.agent_id, ch.by_agent, p.status
from landlord_payouts p
join ch on ch.landlord_id = p.landlord_id and p.created_at > ch.first_change
join landlords l on l.id = p.landlord_id
order by ch.by_agent desc, p.amount desc;
```

The pre-09-09 audit rows don't record old or new values, and before 09-09 there is nothing. So
"what was the number before" can only be reconstructed from `landlord_agreements`,
`landlord_verification_requests.landlord_phone` or `landlord_payout_otp_events.landlord_phone`.

## Not done / hand-offs

- **UI (Gemini's lane).** There is no reviewer queue screen yet. Reviewers need a list of
  `landlord_number_change_requests` by stage, showing `risk_flags`, with approve/reject buttons that
  call `review_landlord_number_change`. `EditLandlordDialog`, `LandlordEditCard`, `MyLandlordsSection`
  and `AgentEditRentRequestDialog` still show "saved" after a number edit that the DB reverted into a
  change request. They should tell the user "a change request was created" instead. Until that
  ships, Ops can review via SQL or the RPC.
- **The unattributed service-role writer (87 changes)** is not identified. Look for its next
  `direct_edit_blocked` row with `actor IS NULL`.
- **47 of the doc-112 backfilled approved numbers** come from a verification-request *contact*
  phone and don't match the landlord's MoMo number. For those landlords, `issue-landlord-payout-otp`
  keeps refusing with "number changed since approval". The fix is a chain change request, not
  loosening the check.
- **3 verified landlords were changed by agents between the 09-22 freeze and this lock.** They are
  already blocked from payout (raw ≠ approved). They weren't reverted, so Ops has to decide.
- **13 verified landlords have no approved number** (verified at INSERT). They are fail-safe
  (blocked). Re-verifying them through `set_landlord_verification` snapshots a number.
- Rejecting a doc-111 "phone change request" via `set_landlord_verification('rejected')` still
  un-verifies the whole landlord and charges the agent UGX 2,000. That's a pre-existing issue and
  wasn't changed here.
- `welile_homes_subscriptions.landlord_phone` (Welile Homes landlord payouts) is a free-text copy
  that isn't tied to verification. It's out of scope and not locked.

## What not to do

- Don't add a bypass for "trusted" roles. The CEO's requirement is that nobody changes an approved
  number outside the chain. Ops included: an ops edit also becomes a request.
- Don't set `landlord_numbers.change_authorized` anywhere except the review, expiry and create
  functions. That flag *is* the lock's key.
- Don't loosen `enforce_landlord_payout_eligibility`'s exact match to a normalized one. Fix the
  caller so it sends the approved value verbatim, as `issue-landlord-payout-otp` now does.
