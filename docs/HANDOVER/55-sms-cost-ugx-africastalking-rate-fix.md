# 55 — SMS cost report priced Africa's Talking at the wrong rate

**Read this before quoting any `get_sms_cost_report` figure broken out by provider, and before
touching `sms_cost_ugx`/`sms_segment_count`/`get_sms_cost_report` again.**

## What was found

Doc 53 shipped `get_sms_cost_report`, pricing every provider at a flat UGX 30/segment. That rate
was confirmed against Yoola's own logged cost cluster — it was never checked against Africa's
Talking specifically.

Josh forwarded AT's own support confirmation (2026-09-17): AT bills **UGX 25 per message**, same
GSM-7 160-char / UCS-2 70-char segmentation thresholds `sms_segment_count()` already implements,
just a different price than Yoola.

Verified against production (last 30 days, `provider = 'africastalking'`): 5,582 messages, 11,493
segments — **UGX 344,790** computed at the old flat 30/segment rate vs the correct **UGX 287,325**
at 25/segment. The old rate overstated AT spend by **UGX 57,465 (16.7%)** over that window. Yoola
(the dominant provider — 30,010 messages / 72,782 segments in the same window) is unaffected;
its 30 UGX/segment rate stays as confirmed in doc 53.

## Fix

`supabase/migrations/20260917130000_sms_cost_ugx_at_rate.sql`:

- `sms_cost_ugx(p_message text)` → `sms_cost_ugx(p_message text, p_provider text default null)`.
  25 UGX/segment when `p_provider = 'africastalking'`, 30 UGX/segment otherwise (Yoola, and every
  other provider seen in `sms_delivery_log` — `lana`, `twilio`, `gate`, `pending` — none of which
  have a confirmed rate either way; left at 30 as the best available assumption, not a
  confirmation).
- `get_sms_cost_report` re-created to pass `l.provider` into every `sms_cost_ugx()` call (totals,
  daily rollup, by-provider, by-source — all four CTEs).
- Old 1-arg `sms_cost_ugx(text)` dropped so there's no ambiguous overload.

`src/hooks/useSmsCostReport.ts`'s doc comment updated to describe the provider-aware pricing (data
shape itself — `SmsCostReport` etc. — is unchanged; only the numbers `cost_ugx` returns for AT
rows differ from before).

## Status — LIVE as of 2026-09-17

Attempting to run the migration directly against prod via `query_database` was blocked by the
auto-mode classifier as a shared-resource write; Josh ran `20260917130000_sms_cost_ugx_at_rate.sql`
by hand via the Supabase SQL editor, same as doc 53's migration. Verified directly against
production: `sms_cost_ugx(repeat('a',87), 'africastalking')` returns 25,
`sms_cost_ugx(repeat('a',87), 'yoola')` and `sms_cost_ugx(repeat('a',87), null)` both return 30 —
matches the fix exactly. `get_sms_cost_report`'s `by_provider`/`daily` AT figures are no longer
overstated.

Also still true from doc 53: `useSmsCostReport`/`smsCostReportPdf` aren't mounted in any page yet —
UI placement is a Gemini task, not done here.
