# 201. Board Technology memo rebuilt on its own RPC (2026-10-07)

**Status: LIVE-DEPLOYED 2026-10-07, preview not yet read. Migration `20261007100000` applied by Josh and verified live; `daily-cto-report` deployed by Lovable from `lovable` (19c4787d9b). Nothing sent to the Board.**

## Why

The 10-06 weekly memo (`Welile_Board_Technology_Memo_Week_Ending_2026-10-06.pdf`) disagreed with the
hand-checked Week 39 board report (`Welile Board Report, Week 39 to Date.pdf`). Checked against live data:

| Memo said | Live data |
| --- | --- |
| Rollback 22.41% "this week" | Sum of **6** days. 1 Oct was dropped silently: the database restarted at 05:35 UTC on 1 Oct, counters went backwards (`-4.5M` rollbacks). The 22.41% is two spike days (30 Sep 37.4%, 5 Oct 36.2%) over a ~2.4% baseline. |
| Delivery sweep "has never marked a single message delivered" | 53 delivered in 30 days, latest 2026-10-06 18:54 UTC. Confirmation exists but covers a small share of traffic. |
| Platform sign-in failure 0.00% | Ignored slow rejections and 1,015 `auth.init.timeout_forced` start-ups. |
| 30,112 access-denied events as auth failures | 14 users; one account is 27,784 of them (redirect loop). |
| SMS "provider refused" | Provider error text shows credit exhausted (555), rate-limited (195), backup key broken (21). 89% ours. |

Root cause in code: `daily-cto-report/index.ts` summed seven `get_cto_daily_report` payloads, and the weekly
trust check (`rollbackBaselineOk`) only asked whether *yesterday's snapshot existed*, not whether the counters
had gone backwards. The RPC's own `rollback_trustworthy` flag was never consulted.

Correction to an earlier note: the 10-05 CTO PDF's 36.22% **does** reconcile with live `pg_stat_database`
(17.6% lifetime). One is the daily delta from `db_stat_snapshots`, the other is cumulative since restart.

## What changed

* **`get_board_tech_memo(p_date)`** (migration `20261007100000`, read-only, same role gate as
  `get_cto_daily_report`). 7 days ending `p_date`, EAT day boundaries. Returns SMS by outcome and cause,
  per-day SMS, top failing streams, e-mail, sign-in (people not clicks; fast/slow reject; start-up timeouts;
  access-denied grouped by user; frozen), OTP by purpose, sign-ups, app errors, per-day rollback with
  restart/reset detection, deadlocks, uptime, slow jobs, cron failures, RLS, backups.
  A day is measurable only if the prior-day snapshot exists **and** counters did not go backwards;
  unmeasurable days are returned as `ok:false`, never dropped.
* **`daily-cto-report/boardMemo.ts`**: `composeBoard()` (narrative, tables, actions, corrections) and
  `buildBoardMemoPdf()` (8-section layout matching the Week 39 report). Pure functions, no I/O.
* **`daily-cto-report/index.ts`**: `report_type: 'board'` now short-circuits to the new path
  (`preview: true` still returns the PDF without emailing). The old board assembly further down the handler
  is now unreachable; deleting it is a follow-up.

## Deliberate limits

* Causes we cannot know (rollback spike, restart, deadlocks) are printed as "not yet established".
* The "Corrections to the source reports" table has fixed wording for what the source reports claim;
  only the corrected figures are computed. Revisit once the source reports are fixed.
* Withdrawal-approval OTPs are not in `otp_usage_events`; the memo says so rather than inventing a row.
* No composite 0-100 health score (the Week 39 report also omits it).
* Local tsc cannot complete (OOM), so the new TypeScript was checked by running `composeBoard` +
  `buildBoardMemoPdf` through `tsx` against a live-data fixture (5-page PDF rendered and inspected).

## To ship

1. Apply migration `20261007100000` (verify `get_board_tech_memo` exists live afterwards; repo migrations
   do not always apply).
2. Deploy `daily-cto-report`.
3. Call it with `{"report_type":"board","preview":true}` and read the PDF before any real send.
4. Tell Lovable after the push.

## Open

* Cause of the 30 Sep and 5 Oct rollback spikes (~1.3M rollbacks/day) and of the 1 Oct restart.
* `/crm/dashboard` access-denied loop (one account, 27,784 events/week).
* Source `get_cto_daily_report` still reports the old sign-in/delivery/rollback figures to the tech report.

## Deploy note

Lovable deployed from `lovable` and, unasked, made two behaviour-preserving edits: `daily-cto-report/index.ts` now uses a `boardMode` boolean in the unreachable old board code (TypeScript rejected the `reportType === 'board'` comparisons after the early return), and `sms-delivery-report/index.ts` imports supabase-js via `npm:` instead of esm.sh. Reviewed; no logic change. Both were redeployed. Next step: run `{"report_type":"board","preview":true}` and read the PDF before any real send.
