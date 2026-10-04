---
name: Funder empty-house booking (Fund now or Promise a date)
description: Supporters book empty houses for 7 days then fund now or promise a date; lapsed holds return to the open pool with SMS + email notices
type: feature
---
Flow: Supporter opens the empty-house picker (`EmptyHouseOpportunitiesSheet` mode="partner") →
picks houses → either **Fund now** or **Promise a date**.

- Booking = `agent_create_promissory_note_for_houses` (payload may carry `promised_funding_date`).
  Each `promissory_note_house_intents` row now has `reserved_until` (default now + 7 days),
  `promised_funding_date`, `warned_at`, `released_at`, `release_reason`, `funded_at`.
  Partial unique index `ux_pnhi_house_reserved` = one live hold per house.
- **Fund now** = `funder_fund_booked_houses(house_ids, term, key)`: marks intents `funded`, then
  delegates to the existing `partner_support_houses` path (pending operational approval; no client
  money movement). **Give up** = `funder_release_booked_houses`.
- Lapse: `psm_release_expired_house_intents()` (cron 03:15) returns houses to the open pool;
  `psm_queue_house_release_warnings()` (cron 06:10) warns 3 days out.
- Notices queue in `promissory_house_booking_notices` (kinds: booked, funded, reminder, released,
  given_up), drained by edge fn `notify-house-booking` (client fire-and-forget + hourly cron).
  Email template `funder-house-booking`; SMS sender always WELILE with Yoola → AT failover.
- Funder UI: `FunderBookedHousesPanel` inside `FunderCapitalOpportunities` lists held/funded/released
  bookings with Fund now / Give up, backed by `funder_booked_houses()`.
