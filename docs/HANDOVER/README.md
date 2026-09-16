# Welile — Engineer Survival Manual

**Purpose of this folder.** `SYSTEM_CONTEXT.md` explains *how the system works*. This folder
explains *how to not destroy it*. It is written for an engineer who has never met the person who
built it, arriving on a bad day, with production already misbehaving.

**Verified against the live database on 2026-09-09.** Every count and every object name in this
folder was read from the production Postgres catalog on that date, not copied from a migration
file or from `SYSTEM_CONTEXT.md`. See [`06-live-state-verification.md`](./06-live-state-verification.md)
for the exact SQL to regenerate all of it, and re-run it before trusting anything here.

---

## The first 60 minutes

If you have just been handed this system and something is wrong, do these in order.

| # | Step | Where |
|---|---|---|
| 1 | **Do not deploy anything.** Not a migration, not an edge function, not the frontend. Read first. | — |
| 2 | Check the kill switches. Somebody may have already paused the platform, or a switch may be wrongly set. | [`02-danger-zones.md` §Kill switches](./02-danger-zones.md#kill-switches--treasury_controls) |
| 3 | Check whether money is still balanced. One query tells you if the ledger is sound. | [`03-money-invariants.md` §Is the ledger healthy right now](./03-money-invariants.md#is-the-ledger-healthy-right-now) |
| 4 | Find your symptom in the runbooks. Each one says what to check and, more importantly, what *not* to do. | [`04-incident-runbooks.md`](./04-incident-runbooks.md) |
| 5 | If you are locked out of an account or vendor, work the access map. | [`01-ownership-and-access.md`](./01-ownership-and-access.md) |
| 6 | If infrastructure is actually gone, work the rebuild order. | [`05-disaster-recovery.md`](./05-disaster-recovery.md) |

**The one rule that matters most:** this platform holds real money belonging to real Ugandan
tenants, agents and Supporters. `general_ledger` is the record of it. It is append-only by design.
You can always fix a wrong balance by posting a new balanced correction. You can never fix a
deleted ledger row. **Never delete, never `UPDATE`, never "clean up" financial history.**

---

## Contents

| Doc | Read it when |
|---|---|
| [`architecture-map.html`](./architecture-map.html) | **Interactive visual map** of platform topology, double-entry invariants, kill switches, runbooks, and recovery sequence. Open directly in any browser. |
| [`01-ownership-and-access.md`](./01-ownership-and-access.md) | You need to get into an account, or you are auditing who holds the keys. **Contains gaps only the founder can fill — fill them.** |
| [`02-danger-zones.md`](./02-danger-zones.md) | Before you run anything that writes. The catalogue of operations that lose money or data. |
| [`03-money-invariants.md`](./03-money-invariants.md) | Before you touch the ledger, wallets, or any balance. The financial contract, with the real source. |
| [`04-incident-runbooks.md`](./04-incident-runbooks.md) | Something is broken and you need a procedure. |
| [`05-disaster-recovery.md`](./05-disaster-recovery.md) | Infrastructure is lost and you are rebuilding. |
| [`06-live-state-verification.md`](./06-live-state-verification.md) | You do not trust this documentation (correct instinct). Regenerates every fact from the live catalog. |
| [`07-tribal-knowledge.md`](./07-tribal-knowledge.md) | The traps that have already cost real money. Read this once, cover to cover, early. |
| [`08-incident-2026-09-12-merchant-claim.md`](./08-incident-2026-09-12-merchant-claim.md) | A merchant says their claim failed, vanished, or "was taken by another agent". The worked incident: why a retry destroyed the claimer's own reservation, what was rebuilt, and what is **still** broken (the 45-minute stale release). |
| [`09-incident-2026-09-12-landlord-payout-otp-lock.md`](./09-incident-2026-09-12-landlord-payout-otp-lock.md) | An agent says paying a landlord shows "network issue" then locks for 10 minutes. Why a slow SMS-delivery check got mistaken for a dead request, why a client-only lock made it worse, and **why the fix is currently reverted** — read the "Is the fix still live" section before assuming it's deployed. |
| [`10-impact-mandatory-payout-verification.md`](./10-impact-mandatory-payout-verification.md) | Before building "block every withdrawal until NID-verified." The feature is already half-built and already stalled at a 3,346-row backlog; real blast radius is ~1,049 users, but zero of them have a name-match record yet, and an exact-name-match rule will misfire on legitimate accounts. |
| [`11-merchant-telecom-charge-atomicity-fix.md`](./11-merchant-telecom-charge-atomicity-fix.md) | A merchant payout's float debit is missing its telecom fee, or before touching `ensure_merchant_payout_float_debit`, `classify_merchant_payout_funding`, or `sweep_merchant_payout_float_debits`. Why every merchant payout silently lost its telecom leg, why a shared idempotency gate permanently blocked backfilling it, and the cutoff-timestamp bug that shipped alongside the fix. |
| [`12-withdrawal-payout-account-lock.md`](./12-withdrawal-payout-account-lock.md) | A user disputes a wallet withdrawal paid to an unrecognized number, or before touching `enforce_withdrawal_payout_account_lock` or `submit_withdrawal_request`. Why the "locked number" promise was UI-only, the DB-level fix, and why a blocked attempt was briefly forensically invisible even after a first fix attempt. |
| [`14-anon-executable-apply-welile-homes-interest.md`](./14-anon-executable-apply-welile-homes-interest.md) | Before touching `apply_welile_homes_monthly_interest`, or if its manager-only page seems to no longer be the only path to it. It had zero authorization check and was executable by `anon` — found while fixing an unrelated wiring bug (the frontend called a nonexistent edge function). Verify the role check and revoked grants are still there before trusting this is fixed. |
| [`15-ip-actor-audit-instrumentation.md`](./15-ip-actor-audit-instrumentation.md) | You need to know whether a sensitive action captures IP/actor identity, before adding a new capture trigger, before trusting `request.headers` for anything, or when `security_ip_audit_alerts` flags something. The full initiative: 49 implementation items, the edge-runtime IP-spoofing correction, client-supplied agreement IPs, the landlord MoMo actor-attribution root cause, the missing-IP watchdog, and the adversarial regression findings — plus what's still open. |
| [`16-wallet-withdrawal-otp-verification.md`](./16-wallet-withdrawal-otp-verification.md) | Before touching `issue-wallet-withdrawal-otp`, `verify-wallet-withdrawal-otp`, or `WithdrawFlow.tsx`'s Verify step. Closes the account-takeover gap where a first-ever payout destination sailed through with no proof of account ownership — two gates, destination verification (one-time) before account-phone OTP (every withdrawal), in that order. Known remaining gap: `profiles.phone` itself isn't OTP-protected against being changed first. |
| [`17-critical-function-drift-detection.md`](./17-critical-function-drift-detection.md) | Before adding to, or trusting, the six-function drift watchlist (`critical_function_baselines`) — or if a scan alert fires. Why it exists (a fix got silently reverted straight against prod, outside any migration), how `scan_critical_function_drift()` works, and a real `text::bytea` hashing bug caught while building it. |
| [`18-email-queue-dispatch-self-cancel-regression.md`](./18-email-queue-dispatch-self-cancel-regression.md) | The CTO report shows `email_queue_dispatch` "job canceled" failures, or before touching that function. Fixed once, silently reverted straight against production with no migration recording it, fixed again the same day — the incident that motivated `17-critical-function-drift-detection.md`. Emails were never actually dropped either time. |
| [`19-frontend-components-missing-backend-rpcs.md`](./19-frontend-components-missing-backend-rpcs.md) | A dashboard tile shows a blank `—`, spins forever, or silently never updates — check this before assuming the data is real. Five components/hooks calling RPCs or edge functions that never existed, how they were systematically found (a full grep + anti-join, worth re-running periodically), and the verification query used for each fix. |
| [`20-cto-report-fabricated-slow-query-recurrence.md`](./20-cto-report-fabricated-slow-query-recurrence.md) | The Daily CTO Report's slow-query section looks identical day after day, or before touching `get_cto_issue_intelligence`'s `slow_queries` block or `daily-cto-report/index.ts`'s slow-query issue builder. Why `daysActive: 30` was a hardcoded literal for every issue forever, the `pg_stat_statements.stats_since` fix, and what the real ages (32–214 days) turned out to be. |
| [`21-referral-bonus-bot-signup-fraud-ring.md`](./21-referral-bonus-bot-signup-fraud-ring.md) | Before touching `get_referral_progress`, `try_credit_qualified_referrals`, `fraud_identity_blocks`, or `handle_new_user`'s signup-velocity guard — or if the Fake Account Radar's `burst_signup` count spikes again. 24 referrer accounts (found across three extension passes) farmed referral bonuses off ~34,311 bot signups, made possible because `get_referral_progress` had been silently gutted to "bare signup qualifies" on 2026-08-10. Root cause fixed, all 24 referrers frozen, ~34,311 bots soft-deleted, a real-time DB-trigger velocity guard added — a much larger 256-referrer/~54K-account pool was measured and deliberately left untouched, since it's dominated by real agent-driven growth. |
| [`22-signup-entry-points-hardening.md`](./22-signup-entry-points-hardening.md) | Before adding a new way to create an account, or before assuming "signup is guarded" covers every entry point — it doesn't. Maps the three account-creation paths and their guards; found `submit-tenant-form` (the public "post a rent request" self-fill link) had **zero** anti-bot rate limiting — fixed by adding the same 5/hour-15/day guard `register-tenant` already had. Not the vector for the 21 incident, but the same shape of hole, found by auditing the "post a rent request" flow Josh suspected. Also covers the same-day hardening of `handle_new_user()`'s velocity cap to 5/hour + 10/day. |
| [`23-automated-bot-referral-ring-hunter.md`](./23-automated-bot-referral-ring-hunter.md) | Before touching `scan_and_quarantine_bot_referral_rings`, its detection thresholds, or the `scan-bot-referral-rings` cron job — this function auto-freezes accounts and auto-deletes rows with no human in the loop, every 30 minutes. The exact validated detection signal (referred-count + name-diversity + non-synthetic-email thresholds), why it's safe to run unattended, and its known limits (no coverage for a referrer-less bot ring). |
| [`30-incident-2026-09-16-collection-guard-vs-float-redesign-drift.md`](./30-incident-2026-09-16-collection-guard-vs-float-redesign-drift.md) | An agent's Confirm Payment fails with "Agents cannot move a rent request from funded to repaying", or a tenant's balance isn't moving despite the agent collecting — or before touching `guard_rent_request_agent_updates` or `agent_allocate_tenant_payment_internal`. A live float redesign shipped straight to production with no migration and stopped writing the ledger leg the guard trusted; 660 collections (UGX 73.8M) since 2026-09-15 15:12 UTC still need `rent_requests` backfilled from the ledger. |
| [`24-orphaned-bot-accounts-from-frozen-referrers.md`](./24-orphaned-bot-accounts-from-frozen-referrers.md) | If a bot cluster survives a referrer-freeze cleanup, or before assuming `profiles.referrer_id IS NULL` means "no connection to a fraud ring." 8 more bot accounts found because `handle_new_user()` strips `referrer_id` when the named referrer is already frozen — correct for stopping the bonus, but it hid them from every referrer_id-keyed sweep. Also: how "was this an engineer" was actually investigated (checked `signup_attempts` telemetry and `origin/lovable` git history — neither can or does show who creates a user account; that's a runtime action, not a commit). |
| [`25-borrowed-identity-payout-consent.md`](./25-borrowed-identity-payout-consent.md) | Before touching `national_id_declarations`, `payout_destination_declarations`, or the `payout-destination-consent` edge function — or before scoping more work on the `payout_destination_verifications` backlog from doc 10. The "one account, one national ID, one phone" policy: SMS-consent gates for National-ID borrowing at signup and payout-destination borrowing, both live in production as of 2026-09-15, both deliberately isolated from commission and never auto-rejecting a mismatch. Frontend wiring for both is still unbuilt. |
| [`28-2026-09-15-payout-verification-session.md`](./28-2026-09-15-payout-verification-session.md) | Full index of everything from the same session as doc 25: the `finops_payout_verification_queue` timeout fix, AI-vision ID-photo enforcement + no-ID auto-reject sweep, the bot-referral-ring fraud-identifier-block gap (fixed), a 91-account/574-destination bulk payout cleanup, three separate withdraw-flow UX bugs, Pius's National-ID-group-linking + identity-binding system (discovered mid-session, one OTP-fast-path change made to it), and the new Settings identity-verification section. Read this before assuming any one of those systems is the only thing gating payouts — four separate, non-integrated verification systems exist. |
| [`26-incident-2026-09-15-merchant-float-autocredit-and-release-bugs.md`](./26-incident-2026-09-15-merchant-float-autocredit-and-release-bugs.md) | A merchant desk's float doesn't match what was actually sent to their phone, or before touching `release_withdrawal_claim`, `tryAutoDebitPayout`'s float-phone match, or `sweepLinkedPendingDeposits`. Three separate things: the manual "release back to queue" float leak (fixed, doc 08 item 2), a one-shot registration-race match that's never retried (self-heal trigger written but **not yet applied to production**), and 14 of 15 "critical" float-uncredited alerts that turned out to be false alarms from a benign crediting race (fixed). Also: why Financial Ops can't see any of this today — zero frontend code reads `deposit_match_alerts`. |
| [`27-incident-2026-09-15-payout-destination-identity-misattribution.md`](./27-incident-2026-09-15-payout-destination-identity-misattribution.md) | **Still partially broken — read before trusting any `user_identity_bindings` row or touching `complete_identity_binding`.** A same-day identity-binding backfill locked 10 accounts' withdrawal identity to a completely unrelated person's mobile money number (an agent reported seeing "landlord's name and number" on her own account); 8 were safely revoked, but 2 immediately got a **fresh** wrong lock because `complete_identity_binding()`'s destination-selection query can't distinguish an account holder's own number from a third party's number they proved SMS ownership of on someone else's behalf — a live gap for any proxy/partner-style account with multiple payout destinations. |
| [`29-cto-report-board-memo-2026-09-16-accuracy-fixes.md`](./29-cto-report-board-memo-2026-09-16-accuracy-fixes.md) | Before trusting the Daily CTO Report or Board Technology Memo PDFs, or before touching `get_cto_diagnostics`, `get_cto_issue_intelligence`, or `daily-cto-report/index.ts`'s Today-bucket/financial-controls/commits rendering. Four fabrications found by verifying the 2026-09-15 PDFs against live production: `status='ok'` auth checkpoints counted as ~28,000 sign-in failures, slow-query severity never actually capped (so chronic 32–210-day-old queries showed as same-day P1s), "Financial controls automated: 164 of 165" contradicting the memo's own "none failing" headline, and a fabricated "Commits: 0" where the truth was "Unavailable" — plus the real root cause: `capture-daily-cto-snapshot` existed only in a migration file, never live, for two weeks. |
| [`31-dormant-referral-shell-guard.md`](./31-dormant-referral-shell-guard.md) | **Migration written but not yet deployed or run — read this before assuming it's live.** Before touching `scan_and_quarantine_dormant_referral_shells`, or before trusting doc 23's hunter as complete coverage. A second, earlier (2026-07) referral-bonus bot ring — 43 referrers, ~17K gibberish-named `@welile.agent` bot signups, UGX 5.76M paid — evades doc 23's guard entirely because it has high name diversity and a synthetic, confirmed email domain, the exact opposite of what that hunter checks for. The new guard instead checks for zero real activity (ledger/rent-request/listing/portfolio) across a referrer's cohort. Still needs deploying, verifying it's live, and one manual wide-lookback backfill run. |
| [`32-agent-allocation-frozen-float-noncumulative-gap.md`](./32-agent-allocation-frozen-float-noncumulative-gap.md) | **`agent_allocate_tenant_payment` is frozen platform-wide right now — every agent's Confirm Payment will fail with `ALLOCATION_FROZEN`. This is intentional, not a bug.** Follow-on from doc 30: agent float is a non-consuming per-transaction gate with no cumulative check, so one static float balance can back unlimited collections — one agent recorded UGX 60M against a 300,000 float over 3 days. Frozen at the platform owner's request pending a real fix (restore float consumption, or add a daily cumulative cap); do not unfreeze without landing one of those first. |
| [`33-tenant-notification-crons-not-scheduled.md`](./33-tenant-notification-crons-not-scheduled.md) | **Live as of 2026-09-16 — read before assuming the tenant notification catalogue has always been sending, or before touching any `tenant-*` `cron.job` entry.** A weekly-report request found the 12-event catalogue (`tenant_notification_events`) had almost no cron coverage — 7 of 8 senders were never scheduled, deliberately, pending the launch guards from the 2026-09-09 dormant-default measurement. Those guards (`EPISODE_START_FLOOR`, `p_require_prior_payment`, `p_max_days_since_last_payment`) were already unconditional in code, so this doc schedules all 7 (10 cron jobs, verified live by `jobid` in `cron.job`, not just the SQL editor's single-row result panel). |
| [`34-restore-float-cap-and-unfreeze-collections.md`](./34-restore-float-cap-and-unfreeze-collections.md) | **The doc-32 fix — migration written and committed but NOT deployed; production is still `ALLOCATION_FROZEN` right now.** Closes doc 32 (daily collected-vs-float cap, since a bare float-debit leg would unbalance `create_ledger_transaction` against the current custody-cash ledger shape) and a second bug found while tracing it: the same agent+tenant+rent_request+amount could be resubmitted every 10-90s for over an hour, each paying fresh commission, because `p_client_ref` idempotency (added 2026-09-09) was never actually passed by either caller. Both callers now pass it; a 2-minute duplicate guard added too. Needs an actual deploy — an agent session could not push it. |
| [`35-payouts-ui-flag-claim-path-bypass.md`](./35-payouts-ui-flag-claim-path-bypass.md) | Before trusting the CTO "Enable Claim & Withdraw buttons" toggle as a full freeze, or before touching `claim_withdrawal_verified`. The `payouts_ui_enabled` freeze only guards *new* withdrawal requests (`BEFORE INSERT` trigger) — it said nothing about claiming/paying an already-queued one. While the toggle was off on 2026-09-16, 7 pre-existing ordinary requests got claimed and 8 processed (UGX 2,168,786), with 7 more (UGX 198,600) still claimable when found. Fixed by adding the same flag check to the claim RPC. Landlord/proxy-partner exemption from the freeze is separate and confirmed intentional, left as-is. |

---

## Known documentation drift — read before trusting `SYSTEM_CONTEXT.md`

`SYSTEM_CONTEXT.md` is a good architecture reference but it has measurably fallen behind
production. Measured 2026-09-09:

| Fact | `SYSTEM_CONTEXT.md` says | Production actually has |
|---|---|---|
| Public tables | 423 | **641** |
| Public functions | 1002 | **1907** |
| Non-internal triggers | 382 | **601** |
| RLS policies | 1141 | **1552** |
| Views / matviews | 22 / 3 | **71 / 6** |
| Enums | 25 | **33** |
| `pg_cron` jobs | 98 (5 inactive) | **151 (9 inactive)** |
| Storage buckets | 21 | **27** |
| Edge functions | 279 | **342** directories in repo |

Two behavioural drifts matter more than the counts:

1. **`get_user_available_balance` no longer reads `v_user_wallet_strict`.** It reads the
   `wallet_balances_projection` table and subtracts `funder_pending_hold()`, plus advance-locked
   withdrawable when the `advance_withdrawals_paused` switch is on. `SYSTEM_CONTEXT.md` §5.3 is
   out of date. The live definition is quoted in [`03-money-invariants.md`](./03-money-invariants.md).
2. **`sweep-agent-advance-recovery` is not a 15-minute job.** It runs once daily at `50 16 * * *`
   UTC. `process-agent-advance-deductions` runs every 6 hours, not daily at 18:00 EAT.
   `SYSTEM_CONTEXT.md` §6.1 and §10 are out of date.

Also note `README.md` claims `guard:all` runs `guard-mcp-deploy.mjs` and `guard-persona-routes.mjs`.
It does not — see `scripts/run-guards.mjs` for the real list of seven guards.

Treat the code and the database catalog as authoritative, always. When you find drift, fix the
document in the same change.
