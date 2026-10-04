---
name: Landlord daily guaranteed-rent SMS broadcast
description: Daily SMS to every landlord phone promoting guaranteed rent + house-listing link
type: feature
---
# Landlord daily guaranteed-rent SMS

Edge function `landlord-daily-guarantee-sms` texts EVERY distinct landlord phone
(`landlords.phone`, deduped, >=9 digits) once per day.

- Cron: pg_cron job `landlord-daily-guarantee-sms`, daily `0 15 * * *` (15:00 UTC
  / 18:00 EAT), POSTs to the function with the anon apikey (no user).
- Provider chain: Yoola (primary) -> Africa's Talking -> LANA. Sender ID `WELILE`.
- Message (current): "Your house shouldn't stay empty. Your rent shouldn't be
  delayed. WELILE connects you to verified tenants and guarantees your monthly
  rent. List your property now: welilereceipts.com/landlord-signup WhatsApp:
  +256 748 747134". Edit the `MESSAGE` constant in the function to change copy.
- Manual test: POST `{ "test_phone": "07xxxxxxxx" }` as a staff user
  (coo/ceo/cto/cmo/super_admin/manager) — sends one message to that number only.
- Logs every send to `sms_delivery_log` (source `landlord-daily-guarantee` /
  `landlord-daily-guarantee-test`) and writes one `audit_logs` summary per run.

## Opt-out
- Every SMS ends with `Stop SMS: https://welilereceipts.com/stop-sms`.
- Public page `/stop-sms` (`StopSms.tsx`) — phone input (prefilled from `?p=`),
  calls edge fn `sms-opt-out` (service role) which upserts into `sms_opt_outs`
  (UNIQUE `phone`, normalized to `+256…`).
- The daily batch loads `sms_opt_outs` once and skips any matching phone; run
  result/audit includes `opted_out` count.
- `sms_opt_outs` is staff-readable (ops roles via `has_role`); writes happen only
  through the `sms-opt-out` edge function.

## Opt-in (resume)
- Public page `/resume-sms` (`ResumeSms.tsx`) — phone input (prefilled from `?p=`),
  calls edge fn `sms-opt-in` (service role) which DELETEs the matching row from
  `sms_opt_outs` (normalized to `+256…`), re-enrolling the number in the daily batch.
- The `/stop-sms` success screen links to `/resume-sms?p=<phone>` ("Changed your
  mind? Resume daily messages").
