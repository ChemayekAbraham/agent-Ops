---
name: Promissory conversion queue analytics
description: Read-only promissory_ops_analytics RPC + PromissoryOpsAnalytics panel — contact attempts, conversion, overdue aging, fulfilment rates by partner and agent
type: feature
---

## RPC `public.promissory_ops_analytics(p_days integer DEFAULT 90)` → jsonb

SECURITY DEFINER, STABLE, **read-only** (writes nothing). Gated by
`promissory_ops_can_act(auth.uid())`, raises `not_authorized` otherwise.
`GRANT EXECUTE` to `authenticated` only.

- Kampala day pinned: `v_today = (now() AT TIME ZONE 'Africa/Kampala')::date`,
  window `v_today - GREATEST(p_days, 7)`.
- Fulfilled = `status='activated' AND approved_at IS NOT NULL`; open = `status='pending'`.
- `partner_key = COALESCE(partner_user_id::text, phone_number, lower(partner_name))`.
- Manual contact attempts come from `promissory_note_ops_actions` (action `contact`);
  automated ones from `sms_delivery_log` sources
  `partner_promissory_note_reminder`, `proxy_promissory_note_reminder`,
  `promissory_fulfilment_due`.
- Output keys: `totals`, `contact` (by_channel / automated_sms / daily),
  `conversion` (contacted vs uncontacted + weekly promised vs fulfilled),
  `aging` (Not yet due, 1-7, 8-14, 15-30, Over 30 days late, No promised date),
  `by_partner`, `by_agent`.

Postgres gotchas hit while writing it: `max()` has no uuid overload — use
`(min(x::text))::uuid`; a correlated `max()` in a select-list subquery is
rejected, so partner `reminders_sent` is a LEFT JOIN on an aggregated sms CTE.

## UI

`src/components/executive/partner-ops/PromissoryOpsAnalytics.tsx` — collapsible
read-only card rendered in `PromissoryNotesQueue.tsx` below the fulfilment
tracker. Window selector 30/90/180/365 days, recharts daily contact chart,
weekly conversion chart, aging bar chart, and partner/agent tables (top 40 by
open value). No figure is computed in the browser beyond percentages of
server-supplied counts.

Live baseline (2026-09-23, 120-day window): 1,593 promises, 1,346 fulfilled
(84%), UGX 723,543,008 fulfilled vs UGX 375,428,000 open (216), 476/490 on time,
1.9 days average wait, 216 open promises with no recorded Partner Ops contact.
