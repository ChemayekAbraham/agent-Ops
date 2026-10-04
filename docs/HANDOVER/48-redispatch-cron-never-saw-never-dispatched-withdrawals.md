# 48 — 2026-09-17: `redispatch-withdrawals` never saw a withdrawal that round 1 never dispatched

**Fixed in code, not yet deployed (edge function — a git push does not deploy it; see
`.github/workflows/deploy-edge-function.yml`, `redispatch-withdrawals` added to its options list
in this same change).** Read before touching `redispatch-withdrawals` or `dispatchMerchants.ts`
again, or before telling a merchant agent "just wait for the app to notify someone."

## The report

Josh: "merchant agent EMMA AND SHAMIRAH, they are not able to withdraw their commission,"
with a screenshot of the standard `WithdrawFlow` step-1 screen.

These are two different bugs. Both agents are themselves `cashout_agents` (merchant/cash-out
agents), trying to withdraw their own commission earnings, not process someone else's payout.

## Emma Maiso (`6bb72978-1450-4800-96c2-8d1414ab2df5`) — not a bug

`profiles.national_id_photo_path` and `selfie_photo_path` are both null; she has a National ID
*number* on file but never submitted the photo/selfie step. Her past withdrawals (through
2026-09-13) completed before the mandatory-photo gate (doc 10) was tightened. She needs to
complete Settings → Account → Verification (ID front, selfie) — the exact thing the red banner in
her screenshot is telling her to do. No code change made for her case.

## Shamirah Nakajjubi (`af04d74b-9c3d-40ea-b99d-41e0a9d59688`) — real bug, real money stuck

She is the **only** row in `user_identity_bindings` platform-wide with a non-empty
`locked_payout_number` (checked live: 36 total `profiles`, 1 with a usable binding), so
`payout_withdrawal_block_reasons` returns cleanly for her — this isn't the same crash class as
doc 44's follow-ons.

Her `withdrawal_requests` row `86cb8b21-a5ee-4f3d-9428-962e6da3f4e0` (UGX 100,000, created
2026-09-16 11:33 UTC) sat `status = 'pending'`, `auto_dispatched = false`,
`dispatch_claimed_by = null`, `dispatch_round = 0` for over a day. Zero rows in
`withdrawal_notification_log` for it — no merchant agent was ever pushed this withdrawal to claim.

Root cause: `trg_notify_merchants_new_withdrawal` (`notify_merchants_new_withdrawal()`) only fires
`AFTER INSERT`, and wraps its `net.http_post` call in `EXCEPTION WHEN OTHERS THEN RAISE WARNING`
— any failure (no eligible online+floated agent at that exact second, the vault secret lookup
missing, the async request never landing) is swallowed with no retry and no record beyond a
Postgres warning nobody reads. The only other path that ever re-dispatches,
`redispatch-withdrawals` (cron, every 1 minute via `redispatch-withdrawals-1min`), only selects
rows where `auto_dispatched = true AND dispatch_expires_at < now()` — a request that was **never**
successfully dispatched has no `dispatch_expires_at` to go stale, so it was permanently invisible
to the retry/escalation cron. Not unique to Shamirah: confirmed 3 other unrelated stuck
withdrawals the same way while investigating (Ian Muhwezi UGX 500,000, Sthername Derrick
UGX 44,300, Nsubuga Dateof UGX 30,000 — all `auto_dispatched = false`, all hours-to-a-day old,
all with zero notification log rows). None of the four were ever escalated to Ops either, since
escalation lives in the same cron and gates on the same `auto_dispatched = true` filter.

At the time of writing there ARE eligible online agents with enough float for Shamirah's Airtel
payout (Hilary Evanz UGX 533,088; Babrah Tusingwire UGX 2,001,312; Mudumba samuel UGX 251,987) —
so this is not a "no agents available" situation, just a request nobody ever told an agent about.

## The fix

`redispatch-withdrawals/index.ts`: added a second query alongside the existing
"dispatched-and-expired" one, for rows where `auto_dispatched = false` and `created_at` is more
than 3 minutes old (grace window for round 1's own async dispatch to land normally) — same
open-status / unclaimed / not-escalated filters, then reuses the identical rebroadcast/escalate
loop. Also fixed `nextRound` computation: `(Number(r.dispatch_round) || 1) + 1` treated
`dispatch_round = 0` (never dispatched) as if it were already round 1, jumping straight to round
2 language; every row this cron previously saw already had `dispatch_round >= 1` so this never
mattered before. Changed to `(Number(r.dispatch_round) || 0) + 1` so a never-dispatched row starts
at round 1 like it should.

## Not done

- **Not yet deployed.** Added `redispatch-withdrawals` to `deploy-edge-function.yml`'s choice list
  and to its `EXPECT_PUBLIC=yes` case (it legitimately carries `verify_jwt = false` in
  `config.toml` — cron-invoked, no user JWT exists). Needs a maintainer to run the workflow by
  hand with `confirm: DEPLOY`. The cron (`redispatch-withdrawals-1min`) already runs every minute,
  so Shamirah's and the other three stuck withdrawals should pick up a round-1 dispatch within a
  minute of deploy, no manual redispatch needed.
- Did not touch `notify_merchants_new_withdrawal()`'s swallowed exception — round 1 still fails
  silently at insert time; this fix only makes sure a silent failure gets a second, third, and
  eventually an escalated chance instead of none. A future pass could log the swallowed
  `SQLERRM` somewhere queryable instead of a Postgres `WARNING`.
- The 3 other affected withdrawals (Ian Muhwezi, Sthername Derrick, Nsubuga Dateof) were not
  manually redispatched or messaged — left for the deploy + cron to pick up naturally, or for Ops
  to action directly if urgency requires it before the deploy lands.
