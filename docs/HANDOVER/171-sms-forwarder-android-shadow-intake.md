# 171 — SMS Forwarder (Android): shadow intake replacing IFTTT → Gmail for MoMo SMS

**BUILT 2026-09-30, not yet applied or deployed. PHASE 1 = SHADOW ONLY: nothing here credits, debits or approves anything.**

Files: `supabase/functions/sms-forwarder-ingest/index.ts`, `supabase/functions/_shared/txnParser.ts`, `supabase/migrations/20260930120000_sms_forwarder_shadow_intake.sql`, `C:\Users\USER\Documents\sms_fowarder` (Android Studio project, its own git repo, moved out of this repo), `supabase/config.toml` (verify_jwt = false for the function, it uses its own device token).

## Why

Doc 170: the single physical chain MoMo SMS → phone → IFTTT → Gmail → poller has no delivery guarantee and died overnight. The phone should forward *evidence*; the server decides how money is recorded.

## What was built

- **Parser extracted, not changed.** `parseTransaction`, `buildDedupKey`, `sha256Hex`, `extractBankBeneficiary` moved verbatim from `gmail-poll-transactions` into `_shared/txnParser.ts`; the poller imports them. Both intake paths now parse identically. Pure move, no logic edit, but the poller was NOT type-checked or run locally (no deno here): confirm it still polls after deploy.
- **Tables** `sms_forwarder_devices` (hashed bearer token, mode, last_seen/battery/pending heartbeat) and `sms_forwarder_messages` (full original body, `unique(device_id, client_message_id)`, parsed fields, `comparison` = pending / matched_gmail / phone_only / unparsed / not_transaction). RLS on, no policies: service role only.
- **`sms-forwarder-ingest`**: `upload` (≤50 msgs, idempotent, acks each `client_message_id` only after the insert; a duplicate retry is re-acked) and `heartbeat`. Compares each parsed TID against `gmail_transactions`; a row still unmatched after 10 min becomes `phone_only` (= IFTTT lost it).
- **`sms_forwarder_shadow_coverage(hours)`** RPC (service role): phone vs Gmail counts, `phone_only_tids`, `gmail_only_tids`.
- **Android app**: `SmsReceiver` (rebuilds multipart SMS, sender allow-list mtn/momo/airtel/yello) → SQLite `Store` first → WorkManager upload with exponential backoff until acked; 15-min heartbeat; inbox re-scan (READ_SMS, last 24 h, safe to repeat because `cid = sha256(sender|ts|body)`); pending/received/failed board.

## Enrol a phone (no UI yet)

```sql
-- generate a token locally (>= 32 chars), store only its sha256:
insert into sms_forwarder_devices (label, sim_label, token_hash)
values ('MTN phone – HQ', '0771…', encode(digest('<TOKEN>','sha256'),'hex'));
```
Paste `<TOKEN>` into the app. Apply the migration first, then deploy the function (it needs the tables).

## Rollout (do not skip)

1. Apply migration, deploy `sms-forwarder-ingest` and (re-deploy) `gmail-poll-transactions`. Verify the poller still ingests.
2. Run the app alongside IFTTT for several days. Read `select sms_forwarder_shadow_coverage(72)`. Only when `phone_only` is understood and `gmail_only_tids` ≈ 0 move on.
3. Phase 2 (NOT built): extract the credit/approve/debit pipeline from the poller (`tryAutoCreditOperationalFloat`, `tryAutoApproveMomoWithdrawal`, `tryAutoDebitPayout`, …) into a shared processor keyed on a source-record layer instead of `gmail_message_id`, keep TID-guard and payout fortress unchanged, then flip devices to `mode = 'live'`. Then disable the IFTTT applets. Gmail ingestion stays for bank emails.

## Limits / open

- Live filters of the IFTTT applets are unverified; the app's sender allow-list is a guess (`Config.ALLOWED_SENDERS`), check the real MTN/Airtel sender IDs on the phone.
- Android may kill the receiver on aggressive OEM battery managers; set the app to Unrestricted. The heartbeat is what lets ops see it. The doc-170 silence alarm does not yet watch `sms_forwarder_devices.last_seen_at`.
- Token is kept in plain private SharedPreferences (device is dedicated; consider EncryptedSharedPreferences).
- Gradle wrapper jar/scripts not included; Android Studio will offer to generate them on first sync (`gradle-wrapper.properties` pins 8.7).
- The Android project was written without being built. Expect a first-sync fix or two.
