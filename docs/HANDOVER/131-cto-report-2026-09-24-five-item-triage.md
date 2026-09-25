# 131 — CTO report (2026-09-24 data, delivered 09-25) five-item triage: one real bug fixed, one already-fixed bug still blocked on deploy, three false alarms

**Auth sign-in false "incorrect password" bug fixed live (`useAuthForm.ts`). Broadcast SMS audience
bug from doc 97 fired again today — still not deployed, same `SUPABASE_ACCESS_TOKEN` blocker as doc
79, needs Josh. Leaflet crash (doc 116) confirmed actually live now. Rollback rate and the seven
slow queries are not real incidents.**

## What was reported

The daily CTO report (2026-09-24 data) tagged 5 items: transaction rollback rate (the only "resolve
Today" item), auth failures + security probes (2 issues, likely the same number), a new "54 users"
outbound notification failure item, `/dashboard/agent` client errors (recommendation #1), and seven
chronically slow statements. Investigated all five in parallel against live production before
touching anything.

## 1. Auth failures (25.5% sign-in failure) — real bug, fixed

The report attributed this to bot/credential-stuffing traffic (issue #9) using OTP verify-rate as
supporting evidence. That comparison doesn't hold — OTP (`otp_verifications`) is a separate flow
from password sign-in (`login_phase_events`) and says nothing about it. `login_phase_events` for
`auth.signin.attempt` over the last 48h: 269 success / 92 error = exactly the reported 25.5%. All 92
errors are real mobile devices on African carrier IP ranges (41.x/102.x/196.x/197.x), diverse
IPs/UAs, no scanning/stuffing signature.

Root cause: `handleSignInSubmit` in `src/hooks/useAuthForm.ts` races 3 guessed placeholder emails
(`{last9}@welile.user` variants) against the real account, falling back to an RPC lookup
(`get_email_by_phone`) only if all three guesses fail. Supabase's `signInWithPassword` returns
"Invalid login credentials" both when the email doesn't exist at all and when it exists with a wrong
password — by design, to avoid leaking account existence. The old code treated *any* such error from
a guessed candidate as proof `accountExists = true`, so a user whose real registered email didn't
match any of the 3 guesses, and whose phone RPC lookup also came up empty/late, was told **"Incorrect
password"** even when their password was correct — the app had simply never found their real login
identifier.

**Fix (live in this commit):** `accountExists` is now only set from RPC-confirmed real emails
(`earlyRpcEmails?.length` / `rpcEmails.length`, both already present), never from a placeholder-guess
failure. `src/hooks/useAuthForm.ts:906-947`. `npm run guard:all` passes (schema-types fingerprint
drift shown is pre-existing/advisory, unrelated to this change — see guard output).

Not investigated further: why `get_email_by_phone` doesn't reliably return every account's real
email fast enough to win phase 1 — that's a separate, lower-severity latency question, not the
correctness bug that was mislabeling wrong-account guesses as wrong passwords.

## 2. New "54 users" notification failure — root cause is doc 97's bug, still not deployed

The report guessed the Africa's Talking SMS outage (14:38-15:03 EAT) explained this. It doesn't:
only 16 of the day's SMS failures were even `africastalking`-attributed, and they don't cluster in
the outage window. The report also undercounted — actual `sms_delivery_log` failures for the day:
437 rows / 307 distinct recipients, not 54.

Root cause: **this is [doc 97](./97-broadcast-agent-audience-counted-whole-platform.md)
recurring**, because its fix was never deployed. 3,930 send attempts / 1,953 distinct recipients from
`source='broadcast_audience'` on 09-24 show the full 3-provider fallback chain exhausting itself —
`yoola:429_rate_limit | africastalking:403/404/405 | lana:400_rejected` — the signature of one
broadcast job sending to far more people than intended, exactly like doc 97's 57,527-recipient
incident. The fix (special-casing `role='agent'` to call `agent_ops_strict_agent_ids()` instead of
the raw `user_roles` table) is present in `supabase/functions/broadcast-audience-sms/index.ts:153-157`
right now, committed 2026-09-21. It has never reached production because the GitHub Actions deploy
workflow has no `SUPABASE_ACCESS_TOKEN` repo secret — the exact blocker doc 79 already escalated for
`daily-cto-report` and `sms-otp`. This is a **deploy gap, not a missing code fix**.

**Needs Josh, not fixable from here (same ask as doc 79, now overdue):** create a Supabase personal
access token scoped to deploy Edge Functions on project `wirntoujqoyjobfhyelc`, add it as repo secret
`SUPABASE_ACCESS_TOKEN` on `weliletenants-sys/welilereceipts-com-98bba33b`
(Settings → Secrets and variables → Actions), then run the manual deploy workflow for
`broadcast-audience-sms` (and `daily-cto-report`, `sms-otp` — all three are blocked on this one
secret). Until then: **do not run another `broadcast_audience` send to "Agents"** — reload the
Broadcast SMS screen with "Agents" selected and confirm the recipient count shows ~233, not
thousands, before anyone sends again. 1,953 today was smaller than the original 57,527, so either
this was a partially-filtered send or the `tenant`/`landlord` audience paths (doc 97 explicitly did
not audit those) carry a smaller version of the same bug — worth checking once deploy access exists.

The 20 new `email_send_log` `dlq` rows on 09-24 are a separate, smaller anomaly not investigated this
pass — safe to requeue (flip `status` back to `pending`) once someone confirms why they landed there.

## 3. `/dashboard/agent` client errors — the known Leaflet fix is confirmed live now

`client_error_reports` for `route ILIKE '%dashboard/agent%'` shows two clusters: an `AgentXxxSheet`
undefined-component family carried over from 09-21 (low volume, ~1/day, not investigated further
this pass), and the `_leaflet_pos` crash from
[doc 116](./116-cto-report-2026-09-24-triage.md) (fix committed `020b159a46`, 09-24). At the
time this triage started it looked like the fix hadn't reached production (errors continued hours
after the commit). Rechecked directly: the last `_leaflet_pos` error in `client_error_reports` is
**2026-09-24 12:16:32 UTC**, zero since, and the Lovable project shows `last_edited_at:
2026-09-25T05:50:53Z` / `is_published: true` — after the last error. **Confirmed actually resolved
in production, no further action taken.**

## 4. Transaction rollback rate ("resolve Today", the report's own top priority) — likely metric
noise, not a real incident

Day-over-day rate (`db_stat_snapshots`, diffed): 09-21 21.3% → 09-22 17.2% → 09-23 5.3% (doc 116's
restatement batch winding down) → **09-24 28.5%, a new peak**. Confirmed it is *not* a continuation
of the 09-21/22 restatement-category spike (09-24's `general_ledger` rows are all ordinary organic
categories) and *not* the still-unexplained 09-19 spike (different day-over-day shape,
[[project_rollback_rate_spike_2026-09-19_resolved]]).

Most likely explanation: several triggers/RPCs shipped in the 09-24 migration wave
(`gate_repaying_on_merchant_landlord_payout`, `promote_rent_request_on_merchant_landlord_payout`,
and the existing `reconcile_merchant_payout_funding`) wrap their audit-log inserts and update steps
in `EXCEPTION WHEN OTHERS THEN NULL` blocks. Each caught exception is a subtransaction rollback that
still increments `pg_stat_database.xact_rollback` even though the outer transaction commits normally
— this matches the report's own "0 users affected" note (a real rejected write would be user-visible;
these aren't). **Not confirmed with certainty** — there's no per-function exception log in
production, so this can't be attributed by call volume the way the finding above could. No code
change made.

**Still needed, escalating again:** real Postgres error-log access (Supabase dashboard → Logs, or a
DB-side exception log) to attribute rollback counts to a specific function. This exact gap was
already flagged by
[doc 101](./101-2026-09-22-cto-report-email-queue-sixth-regression-and-active-rollback-spike.md) and
never closed — worth doing once, since it will keep costing a "resolve Today" tag on every report
until it exists.

## 5. Seven slow statements — mostly a known false pattern, one real question

Four of the five PL/pgSQL functions listed (`recompute_trust_scores_batch`,
`reconcile_evidenced_withdrawal_settlements`, `repair_wallet_cache_drift`,
`detect_wallet_projection_drift`) are cron-scheduled, not called per-request — confirmed via
`cron.job` and a repo-wide grep (no caller in `src/**` or `supabase/functions/**`). The report's own
"climbing call count" signal (64→76→88) is
[the same fabricated-recurrence pattern doc 20 already documented](./20-cto-report-fabricated-slow-query-recurrence.md):
`pg_stat_statements` counts are lifetime-cumulative, not a sign of rising call frequency. No code fix
applies to these four.

One real, unexplained change: `refresh_wallet_totals_cache` is scheduled every **3 minutes** live,
but its own migration (`20260713161737`) originally scheduled it every **10 minutes** — no migration
file shows the tightening, meaning someone changed the `cron.schedule` directly (matches
[[project_repo_migrations_diverge_from_production]]). It's the heaviest total-time consumer of the
seven (56.2M ms across 3,689 calls). Widening it back to 10 minutes would cut its aggregate load
~70% with no code change — but nobody currently knows why it was tightened, so this is a question for
whoever owns that cadence, not a fix applied here.

## What was deliberately not done

- Did not touch the `broadcast-audience-sms` edge function code — it's already correct, doc 97
  covers it, the only gap is deploy access which this session doesn't have.
- Did not requeue the 20 `email_send_log` dlq rows or attempt to resend any of the 09-24 SMS
  failures — resending real messages to real users needs a human call on which recipients still
  need the notice, not an automatic bulk requeue.
- Did not touch `refresh_wallet_totals_cache`'s cron schedule — changing production cadence without
  knowing why it was tightened risks reintroducing whatever the 3-minute schedule was compensating
  for.
- Did not attempt to work around the `SUPABASE_ACCESS_TOKEN` gap (embedding a token, reading `.env`,
  etc.) — same rule doc 79 already stated: `.env` is hands-off and a deploy token belongs in GitHub
  Actions secrets only.

## Verify

```sql
-- auth fix: no code to verify live via SQL, but confirms the failure signature this fixed
select count(*) filter (where status='error') as errors, count(*) as total
from login_phase_events where phase = 'auth.signin.attempt' and created_at > now() - interval '48 hours';

-- leaflet: confirms resolved
select count(*) from client_error_reports
where message ilike '%_leaflet_pos%' and created_at >= '2026-09-24 12:16:33+00'; -- expect 0

-- broadcast bug recurrence check, run before/after the deploy lands
select count(*) as attempts, count(distinct recipient_user_id) as recipients
from sms_delivery_log where source = 'broadcast_audience' and created_at::date = current_date;
```
