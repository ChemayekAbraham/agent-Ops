# 53 — SMS cost/usage report, plus two SMS senders that logged nowhere

**Read this before trusting any prior "how much did we spend on SMS" figure, before touching
`get_sms_cost_report`/`sms_segment_count`/`sms_cost_ugx`, or before touching
`broadcast-audience-sms` / `send-rent-access-sms`.**

## What was asked

Josh needs a downloadable report reconciling actual SMS spend against Yoola credit top-ups —
Yoola charges ~UGX 30 per message, scaled by character-count segmentation, and he wants every
tenant message accounted for.

## Finding 1 — `sms_delivery_log.cost` (the provider's own figure) is not trustworthy

Checked the last 30 days: only 21,998 of 31,383 Yoola rows (70%) have a `cost` value at all. Of
the ones that do, the values contain clear errors — 52 messages exactly 87 characters long
(comfortably a single 160-char GSM-7 segment, should cost UGX 30) are logged at **UGX 360**, 7 more
at **UGX 390**, and 21 messages of 220–370 characters are logged at **UGX 0**. This column cannot
be summed directly for a spend report.

**Fix:** `get_sms_cost_report` (new RPC) computes cost independently from `length(message)` using
the standard segmentation rule — GSM-7: 160 chars single-segment, 153/segment once concatenated;
UCS-2 (any non-ASCII byte): 70 single, 67/segment — at UGX 30/segment. Verified against the sane
cluster of existing cost values (UGX 30 up to 160 chars, UGX 60 up to ~306, UGX 90 up to ~401 —
consistent with 153 chars/segment). New functions: `sms_segment_count(text)`, `sms_cost_ugx(text)`.
Not yet applied — see Status below.

## Finding 2 — two SMS senders wrote to no cost-visible table at all

Grepped every edge function with a direct `fetch()` call to a Yoola/AT/LANA endpoint (25 files;
most funnel through the shared `_shared/sendSmsMultiProvider.ts` / `_shared/yoolaPrimary.ts`
helpers, which do log correctly). Two do not:

- **`broadcast-audience-sms`** — the backend for the CTO Communication tab's "Broadcast" button,
  which sends to entire tenant/agent/landlord role cohorts. Its campaign-mode path wrote only to
  `sms_broadcast_log` (a separate table with no `message` body stored, so cost can't even be
  back-computed from it), and its **legacy synchronous path — used for test sends and small
  broadcasts — wrote to no table at all.** Any mass audience blast run this way was completely
  invisible to spend reporting.
- **`send-rent-access-sms`** — sends a tenant "Rent Money You Can Get" card link, both on manual
  agent share and automatically after every agent allocation. Logged only a best-effort
  `system_events` row, and only when a `tenant_id` was supplied — otherwise nothing.

**Fix:** both now also insert into `sms_delivery_log` on every attempt (accepted or failed),
alongside their existing behavior — additive, not a replacement, so campaign resumability
(`sms_broadcast_log`'s `campaign_key`+`phone` idempotency) and the existing `system_events` audit
trail are untouched. `send-rent-access-sms`'s `sendSMS()` now returns which provider actually
accepted the message (it previously discarded that), so the log row attributes cost correctly per
provider.

## Known remaining gap — not fixed this session

The same "0 sms_delivery_log references despite a direct provider fetch()" grep also flagged:
`warn-malformed-names`, `viewing-confirmation-sms`, `wallet-transfer`, `cto-issue-temp-password`,
`notify-withdrawal-claimed`, `sms-test-send`, `cto-broadcast-partners-sms` (the Partner-audience
equivalent of `broadcast-audience-sms` — likely has the identical legacy-sync-path gap). None of
these were fixed here; the cost report will undercount by whatever volume they send until they
are. `cto-broadcast-partners-sms` is the highest-priority follow-up given it shares
`broadcast-audience-sms`'s shape.

## Report itself

`get_sms_cost_report(p_start date, p_end date, p_provider text default null)` returns totals
(messages/segments/cost, split sent vs failed), a daily rollup (messages/segments/cost per
provider bucket), a by-provider breakdown, and a by-source top-30 (which feature/campaign the
spend came from — e.g. `advance_deduction_missed`, `signup_rent_prompt`, `withdrawal_claim` were
the top three sources by Yoola volume in the last 30 days). Cost counts every **attempted** send
(a provider-accepted message that later failed handset delivery still consumed credit) but
excludes `status = 'skipped'` rows (governor/frequency-cap refusals that never reached a
provider).

Frontend: `src/hooks/useSmsCostReport.ts` (data-fetching only, per CLAUDE.md's division of labor)
and `src/lib/smsCostReportPdf.ts` (a new two-page PDF: daily cost table + by-source breakdown,
same visual style as the existing `smsTrafficReportPdf.ts`). Neither is wired into a page yet —
that's a UI placement decision (likely a new tab/section on `CTOCommunicationOverview.tsx` or
`SmsDeliveryLogViewer.tsx`), left for Gemini per the same division-of-labor pattern used for the
Tenant Notifications tab in doc 33.

## Status — NOT YET LIVE

`supabase/migrations/20260917100000_sms_cost_report.sql` is written and committed but not applied
— same pattern as every other migration this session (doc 33, doc 39): the auto-mode classifier
does not allow direct schema writes against production from here. Run it via the Supabase SQL
editor, then verify:

```sql
select get_sms_cost_report(current_date - 6, current_date);
```

returns non-null totals before trusting any number from it.
