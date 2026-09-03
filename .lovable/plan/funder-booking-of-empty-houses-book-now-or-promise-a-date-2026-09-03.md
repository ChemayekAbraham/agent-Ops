# Funder booking of empty houses (book now or promise a date)

Goal: a funder browses empty houses on the platform, books the ones they want, and either funds them immediately from their wallet or promises a future funding date. Unfulfilled promises expire, the houses go back into the open empty-house list, and the funder is told by SMS and email at every step.

Confirmed rules: 7-day hold (same as the existing promissory tenant-plan bookings), released houses return to the open pool for anyone to book, notices go out by SMS and email, and the picker offers both "Fund now" and "Promise a date".

## What the funder sees

1. **Browse empty houses** — the existing empty-house picker in the Funder dashboard (photos, rent, district, landlord, GPS, verified badge) stays as-is, with server-side search and filters.
2. **Select houses** — running totals: houses, one month of rent each, expected 15%/month return.
3. **Two actions on the selection**
   - *Fund now* — money moves immediately from the funder's wallet/float to the listing agent's landlord float; houses are marked funded and an agent is expected to place a tenant.
   - *Promise a date* — houses are held for the funder for 7 days, with the promised funding date recorded on the booking. No money moves.
4. **My booked houses** — a new panel on the funder dashboard listing their held houses: promised date, days left, "Fund now" per booking or for all, and a "Give up this house" release action.
5. **Status is honest** — held houses disappear from every other funder's list while reserved and reappear the moment they lapse or are given up.

## Lifecycle

```text
empty house  ->  booked (held 7 days, promised date)  ->  funded  ->  agent places tenant  ->  repayment starts
                        |                    |
                        |  3 days left: reminder (SMS + email)
                        |
                        +--  7 days pass unfunded  ->  released  ->  back in the open empty-house list
                                                          (release notice: SMS + email)
```

## Notifications (SMS + email, every scenario)

| Event | Message |
|---|---|
| Booking created (promise) | Houses held, total to fund, promised date, release date |
| Booking funded (now or later) | Confirmation, amount, houses, what happens next (agent finds a tenant) |
| 3 days before release | Reminder with days left and the funding link |
| Released after lapse | Houses returned to the open list, what to do to re-book |
| Funder gives up a booking | Confirmation the houses were returned |

All notices queue in the database and are drained by a worker, matching the existing pledge/release notice pattern, so no notice is lost and none is sent twice.

## Technical notes

Database (single migration):
- `promissory_note_house_intents` gains `reserved_until` (default `now() + 7 days`), `promised_funding_date`, `warned_at`, `released_at`, `release_reason`, `funded_at`, `updated_at` + updated-at trigger. Existing reserved rows are backfilled with a 7-day window from `created_at`.
- Partial unique index so one house can only have one `reserved` intent at a time (hardens the current `NOT EXISTS` check against races).
- RLS: add a policy so a funder can read intents on notes where `promissory_notes.partner_user_id = auth.uid()`.
- New notice queues `promissory_house_booking_notices` (kind: `booked`, `funded`, `reminder`, `released`, `given_up`) with GRANTs, RLS (owner read, service_role all) and idempotency on `(intent_batch, kind)`.
- `agent_list_empty_house_opportunities` authorisation extended to `supporter` (currently agent/ops only) so the funder picker uses the same paginated, filtered source; eligibility keeps excluding houses with a live reserved intent.
- `agent_create_promissory_note_for_houses` accepts `promised_funding_date`, stamps `reserved_until`, and queues a `booked` notice.
- `funder_fund_booked_houses(p_intent_ids uuid[], p_idempotency_key text)` — SECURITY DEFINER: checks the caller owns the note, checks capacity via `funder_support_capacity`, releases to each listing agent's landlord float through the existing landlord-float disbursement path (ledger-only money movement, `recipient_type` routing untouched), marks intents `funded`, queues a `funded` notice.
- `funder_release_booked_houses(p_intent_ids uuid[], p_reason text)` — funder-initiated give-up; marks `released`, queues `given_up`.
- `psm_release_expired_house_intents()` and `psm_queue_house_release_warnings()` mirroring the plan-intent versions, on the same daily crons (release 03:10, warnings 06:05); expiry emits a `system_events` row and queues a `released` notice.

Edge function:
- `notify-house-booking` — drains `promissory_house_booking_notices` in one round trip, sends via Yoola SMS (sender `WELILE`, Africa's Talking failover) plus the transactional email route, marking SMS and email independently. Cron every 10 minutes, plus fire-and-forget invoke from the client after booking/funding.

Frontend:
- `EmptyHouseOpportunitiesSheet` (partner mode) gains the promised-date field and the "Fund now" / "Promise a date" split action; existing agent mode behaviour unchanged.
- New `FunderBookedHousesSection` on the funder dashboard (booked list, days-left badges, fund/give-up actions), realtime-refreshed on `promissory_note_house_intents`.
- Copy uses Rent Plan / Supporter / Returns terminology and `formatUGX`.

Unchanged: rent-request pipeline and `funder_support_tenant_direct`, wallet bucket rules and the strict withdrawable gate, the 15% return rate, agent-created notes, and the empty-house summary card.
