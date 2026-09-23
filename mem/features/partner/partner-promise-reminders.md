---
name: Partner promissory-note recurring reminders
description: Partners get an SMS every Mon/Wed/Fri 09:30 EAT while their funding promise stays unfulfilled
type: feature
---
# Partner promise reminders (recurring)

Companion to `proxy-promissory-note-reminders` (which chases the recording agent). Until 2026-09-23 the partner was only texted once, on the fulfilment due day.

- Edge fn: `supabase/functions/partner-promissory-note-reminders` (deployed 2026-09-23).
- Cron: `partner-promissory-note-reminders-0930-eat`, `30 6 * * 1,3,5` (09:30 EAT Mon/Wed/Fri), registered via direct `cron.schedule` SQL (not a migration file).
- One SMS per partner per day (grouped by `partner_user_id`, else note phone), idempotency `partner-promise-reminder-{key}-{kampalaDate}`, source `partner_promissory_note_reminder`.
- Skips: notes <48h old, non-`pending` status, partners with no reachable phone (note `whatsapp_number`/`phone_number`, then `profiles.phone`).
- Read-only over `promissory_notes` + `profiles`; no wallet/ledger/note mutation. `{dry_run:true}` body previews without sending.
- SMS via `_shared/sendSmsMultiProvider.ts` (Yoola → AT → Lana, sender WELILE); signup prompt suppressed.
