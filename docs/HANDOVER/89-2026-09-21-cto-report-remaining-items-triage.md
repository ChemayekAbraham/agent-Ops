# 89 — 2026-09-21: CTO report triage — auth failures, "slow" trust-score batch, client errors, unattributed API failure

Doc 88 (same day, parallel session) already covered the CTO report's items 1 (`email_queue_dispatch`
self-cancel, fifth occurrence, fixed) and 3 (rollback-rate spike, confirmed real and already
self-resolved). This doc covers the four remaining items from the same report. No production writes
were made for these four — investigation only, since none of them turned out to need a backend fix.

## 1. Auth reliability: 20.6% sign-in failure — real, but not what the report's own hypothesis says

Verified against `login_phase_events` filtered to `phase = 'auth.signin.attempt'` for 2026-09-20
(Kampala day): 85 success + 22 error = 107 attempts, 22/107 = 20.6% — the report's number is
accurate for that phase. (Caution for next time: `get_cto_diagnostics()`'s own `auth.login_attempts`/
`login_failures` fields count *every* row in `login_phase_events` regardless of phase — including
`auth.enforceAccountAccess.end`, `gate.account_frozen.check`, etc., which use `status = 'ok'` and are
not sign-in outcomes at all. That aggregate is not usable as an auth failure rate; only the
`auth.signin.attempt` phase is. It happened to not be the number quoted in this report, but a future
session should not trust `v_auth.login_failures` from that RPC at face value.)

All 22 error rows share the same shape: `detail = {accountExists: true, attempts: 6-7, winnerPhase:
null}`. Source IPs are diverse (41.x/79.x/104.x/196.x/212.x/81.x, mostly African mobile/residential
ranges) with at most 2-3 recurrences per IP spread over hours — **not credential-stuffing**, ruling
out the report's own first hypothesis. One user (`7be2365f-...` at `41.75.183.151`) retried 3 times
in 20 seconds with `totalMs` of 14-29s each; most others resolved in under 2 seconds before giving up.

**Reading of `winnerPhase: null` after 6-7 attempts with a confirmed-existing account:** the sign-in
flow appears to race multiple auth strategies and take whichever resolves first; these 22 all
finished with none of the racers ever winning. This is a client-side sign-in orchestration bug, not
an OTP delivery problem — the OTP/email queue explanation the report suggests doesn't fit: `email_queue_dispatch`'s
disarm bug ([[project_email_queue_dispatch_self_cancel_drift]]) is confirmed cosmetic (both `pgmq`
queues stayed empty), and none of these 22 error payloads mention OTP at all. **Items 2 and 3 in the
report are not the same issue** — treat them independently going forward.

**Not investigated further this pass:** the actual sign-in race/orchestration code (likely an
auth hook under `src/hooks/`) — that's the next step, not covered here.

## 2. Slow statement cluster: `recompute_trust_scores_batch` is not a new regression, and not a lock/timeout issue

Checked `cron.job_run_details` for jobid 12358 (`recalculate-trust-scores-rolling`, every 2h) back to
2026-09-14: every single run in that week is 90.00-90.6 seconds, status `succeeded`, zero failures.
The duration is a **self-imposed budget**, not a cap being hit involuntarily:

```
v_deadline timestamptz := clock_timestamp() + interval '90 seconds';
...
IF clock_timestamp() > v_deadline THEN v_timed_out := true; EXIT; END IF;
```

The report's framing ("jumped from 25s Friday to a pinned 90.07s Saturday, something changed in that
window") does not hold up — this function has run at ~90s every single time for at least a week. What
actually changed is that it started ranking in the top-10 `pg_stat_statements` slow-query list on
Saturday; the Friday "25,037.7ms" entry in that list was a different query. **No lock contention, no
timeout misconfiguration, no deploy to chase.**

**A real (lower-urgency) finding this surfaced, not previously quantified:** `welile_trust_score_cache`
has 96,745 rows (1:1 with `profiles`), and only ~818 got refreshed in the last 2 hours — meaning a
full rotation through every user, at current throughput, takes roughly 96,745 / 818 ≈ 118 runs ×
2h ≈ **~10 days**. Trust scores can be up to ~10 days stale under the current budget. Not an incident,
but worth a capacity look if trust score freshness matters for near-real-time lending/eligibility
decisions — either raise the 90s budget, run more often than every 2h, or process in stale-first order
more aggressively (it already does stale-first, so the fix is throughput, not ordering).

## 3. `/dashboard/agent` client errors (194/week) — two real clusters, not 194 distinct bugs

Grouped `client_error_reports` by message for `route ilike '%dashboard/agent%'` (7-day window):

| Cluster | Count | Likely cause |
|---|---|---|
| `Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.` + `Attempt to get all index records from database without an in-progress transaction` | 69 | An IndexedDB-backed offline cache whose connection is being closed (tab hide, navigation, or an explicit `.close()`) while a transaction is still in flight — classic teardown-race, not a data-loss bug per se but worth guarding. |
| `Cannot read properties of undefined (reading 'AgentLandlordFloatAllocationsDialog')`, `'AgentTenantsSheet'`, `'AgentAdvanceRequestForm'`, `'AgentCashPayoutsTab'`, `'AgentPromissoryNotesList'`, `'AgentListingsSheet'`, `'ListEmptyHouseDialog'` (+ 1 non-standard phrasing of the same) | 49 | Classic lazy-import/chunk-loading failure shape — a `React.lazy()` dynamic import resolving to `undefined` instead of the expected component, typically from a stale client bundle referencing a chunk hash a new deploy removed. |

Breakdown by browser (3-day window): 49 Chrome desktop, 23 Android, 3 iOS Safari — no single-platform
concentration, consistent with a deploy-cadence issue rather than a device-specific bug.

**Note for whoever picks this up:** `AgentCashPayoutsTab.tsx` and `AgentDashboard.tsx` are both
uncommitted modifications in the working tree as of this triage (2026-09-21), and `AgentCashPayoutsTab`
is literally one of the failing lazy-loaded components. Worth checking whether the in-progress edit is
related before assuming it's purely a stale-deploy artifact. This is UI/component-composition territory
(lazy import wiring in `AgentDashboard.tsx`) — per this repo's Claude/Gemini split, the fix belongs to
whoever owns `src/components/agent/*` JSX, not this pass.

## 4. "API failures on unattributed client request" — false alarm, not a backend issue at all

The single flagged failure is not a cold-start or connectivity problem. Every occurrence (11 across
2026-09-19/20, all `/cmo/dashboard?section=user-analytics`, same user, same Mac/Chrome) has this
stack:

```
TypeError: Failed to fetch
    at o (chrome-extension://hoklmmgfnpapgjgcpechhaamimifchmp/frame_ant/frame_ant.js:...)
    ...
    at Xt.window.fetch (https://welileapp.com/assets/ScreenLoader-...js:...)
```

`chrome-extension://hoklmmgfnpapgjgcpechhaamimifchmp` is a third-party browser extension monkey-patching
`window.fetch` and throwing before the request reaches the network — the request never left the
browser, let alone reached an edge function. This is one CMO's local ad/tracker-blocking extension
interfering with an analytics fetch, not a backend reliability issue. **No cold-start investigation,
no warm-instance setting, no server-side action needed.** If it recurs, the fix (if any) is telling
that one user to disable the extension for this site, or wrapping the affected fetch call defensively
so a blocked request degrades instead of throwing an unhandled rejection.

---

## What not to do

- Don't re-diagnose `recompute_trust_scores_batch`'s duration as a lock/timeout problem — it's a
  documented, intentional budget (see `repair_wallet_cache_drift`'s identical pattern and comment).
- Don't chase the item-6 "unattributed API failure" as a backend issue — check for
  `chrome-extension://` frames in the stack before assuming an edge function problem.
- Don't assume items 2 and 3 (auth failures / email queue) share a root cause without checking —
  they don't, this time.
