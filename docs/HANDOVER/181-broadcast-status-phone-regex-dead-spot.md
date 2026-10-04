# 181 — Broadcast Status page was a dead spot: phone regex matched nothing

## Status
**BUILT 2026-10-01, not yet applied.** Migration `20261001090000_fix_broadcast_status_phone_regex.sql`. Verify the live function body after Lovable applies it (doc 06).

## DO NOT CLICK "Retry failed" on `/cto/dashboard?section=broadcast-status` UNTIL THIS IS APPLIED AND THE NUMBERS LOOK RIGHT
The page's numbers are wrong, so its button invites a retry of campaigns that are finished.

## What was wrong
`get_sms_broadcast_status` filtered deliveries with `l.phone ~ '^\\+256[0-9]{9}$'`, introduced in the 2026-07-08 migrations. With `standard_conforming_strings = on` that regex requires a literal backslash, so no `+256…` number ever matched. Every campaign got `sent = 0`, `failed = 0`; the panel then showed processed 0, queued = `total_recipients`, a "Sending" badge, and an enabled "Retry failed (total)" button. Wrong since July.

Live on 2026-10-01 (queried read-only, nothing sent):
| Campaign | Panel showed | Truth (valid +256 rows) |
|---|---|---|
| `welileapp-move-2026-07` | 0 sent, 13,883 queued, "Retry failed (13,883)" | 13,758 sent + 125 failed = 13,883. Outstanding 125. |
| `rent-access-30m-tenants-with-balance-2026-09-26` | 0 sent, 725 queued | 724 sent + 1 failed = 725. Outstanding 1. |

474 other rows in `sms_broadcast_log` are non-`+256` (foreign or stale numbers); the filter is meant to exclude them and still does.

## What the Retry button actually does (read from `broadcast-audience-sms`, not run)
It re-invokes the edge function with the stored audiences and message. With a `campaign_key` set, the function pages through all `sent` rows and skips those numbers, so a retry would not blindly re-send to everyone. It still: rewrites the campaign row (`status = 'running'`, `total_recipients`), increments `run_count`, flips non-audience failed rows to `invalid`, and sends to every recipient not marked sent: the 125 failed plus any recipient with no row. That costs SMS credit and hits provider rate limits (Yoola 429, see doc 176). So it is not catastrophic, but it is not "re-fire 13,883" either, and nobody should press it based on the wrong page.

## Change
One regex: `'^\+256[0-9]{9}$'`. Same body, signature and grants otherwise. Not baselined in `critical_function_baselines`.

## Not changed (noted)
- The edge function's paged reads of `sms_broadcast_log` use `.range()` without an `ORDER BY`. Fine on a quiet table; a stable order would be safer. Left alone.
- The page auto-refreshes every 4 s and the button is UI (Gemini's lane); with correct numbers it reads "Retry failed (125)".

## Verify after apply
`select campaign_key, sent, failed, total_recipients from get_sms_broadcast_status()` as a privileged session: sent + failed = total for both campaigns, and the page shows "Complete" or 125 outstanding.

## Rollback
Re-apply `20260708185222` (restores the broken regex; not recommended).

## Architecture map
No update: fixes one reporting RPC.
