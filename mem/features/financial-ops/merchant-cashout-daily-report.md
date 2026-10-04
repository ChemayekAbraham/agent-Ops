---
name: Merchant cash-out daily payout report
description: Automated 00:00 EAT (corrected from 22:00 EAT) email report of each merchant (cash-out) agent's payouts + commission, sent to fixed ops recipients from ledger-accurate figures
type: feature
---
**Corrected 2026-08-14:** the only `cron.schedule` in the repo registers job
`merchant-cashout-daily-report` at `0 21 * * *` (21:00 UTC = **00:00 EAT**)
(`supabase/migrations/20260728094645_7c5f97ef-e969-4669-9f6a-8dd7bf1dece9.sql:237-259`), and the
function's own header confirms "Scheduled at 00:00 EAT (21:00 UTC)"
(`supabase/functions/merchant-cashout-daily-report/index.ts:3-4`). The "22:00 EAT" /
`merchant-cashout-daily-report-2200-eat` job name below was stale by two hours — see
`docs/investigations/Financial_Ops_Wallets_Merchant_Agents_Verified_2026-08-14.md`. Recipients have
also grown to three: weliletenants@gmail.com, joshwanda17@gmail.com, benjaminmuhanguzi29@gmail.com.

Nightly at **00:00 EAT (21:00 UTC)** the `merchant-cashout-daily-report` edge function emails an accurate per-merchant cash-out payout report to **weliletenants@gmail.com**, **joshwanda17@gmail.com**, and **benjaminmuhanguzi29@gmail.com**.

**Accuracy source (Phase 11, 2026-08-12):** SECURITY DEFINER RPC `generate_merchant_cashout_daily_report(p_date date)` is **request-driven, not ledger-driven**. Candidate set = day's posted customer-wallet-debit legs UNION `withdrawal_requests` whose day anchor (`processed_at` → `settlement_checked_at` → `dispatch_claimed_at` → `fin_ops_approved_at` → `created_at`) falls in the EAT day with status in paid/completed/disbursed/processing/failed/held/re_approved_for_recovery. Ledger-less payouts can therefore NEVER disappear from reporting.

Every payout carries `settlement_status`: `fully_settled` | `reconciled` (repaired via `withdrawal_settlement_replay_audit`) | `partially_settled` | `unsettled` (paid with no customer wallet debit, or ≥3 missing legs) | `failed` (failed/held/stuck processing) | `exception` (ledger orphan / unclassifiable). Derived from `withdrawal_requests.settlement_state` + `settlement_missing_legs` + presence of the customer wallet debit leg (any date).

Money totals (`total_paid`, `total_commission`, `total_telecom`, `total_float_consumed`, per-merchant, per-category) count only clean rows (`fully_settled`/`reconciled`); dirty rows surface separately as `unresolved_payouts`/`unresolved_amount`, `settlement_totals`, `by_settlement_status[]`, and `exceptions[]`. Commission leg marker `'<wd>-cashout-commission'`; principal legs `'<wd>-merchant-float-consume'` / `'<wd>-merchant-reimbursement'`; amount falls back to `withdrawal_requests.amount` when no legs exist. Day boundary `Africa/Kampala`. Email renders a "Settlement Status" block, a "Needs Reconciliation" list, and per-payout status pills.

**Email path:** enqueues raw HTML via `enqueue_email('transactional_emails', payload)` → `process-email-queue` → `sendLovableEmail`. Transactional sends REQUIRE `unsubscribe_token` (400 `missing_unsubscribe` otherwise) — the fn upserts one per recipient into `email_unsubscribe_tokens`. From `Welile Reports <info@welile.com>`, sender_domain `notify.welile.com`.

**Idempotency/audit:** one `system_events` row `event_type='merchant_cashout_daily_report'` per EAT day (skips duplicates unless POST body `{force:true}`); POST `{date:"YYYY-MM-DD"}` overrides the day. Cron job `merchant-cashout-daily-report` (`0 21 * * *` UTC = 00:00 EAT — see correction note above; the job is NOT named `-2200-eat`).
