# 56 — "Delivered" always read 0 on the Tenant Notifications tab

**Read this before touching `get_tenant_notification_performance` or `get_tenant_channel_performance`
again, or before trusting a "Delivered" figure from either.**

## What was reported

Josh flagged that the CTO Communication tab's Tenant Notifications table always shows `Delivered =
0` for every event, screenshot attached: Payment received, Merchant code reminder, Tenant
relocation, Rent limit progress, Missed payment, Partial payment, 5-Day default, Rent limit
increased — all zero in the Delivered column despite dozens of Sent. His diagnosis: "the API never
send[s] back a delivered [status] so we mark sent as delivered."

## Root cause, confirmed against production

Both RPCs computed `delivered` as `l.status = 'sent' and sms_delivery_log.status = 'delivered'`,
per doc `20260909170000_tenant_notification_analytics.sql`'s Part 7 comment, which assumed Africa's
Talking's delivery-report callback (`sms-delivery-report`) would eventually populate that status.

```sql
select count(*) from public.sms_delivery_log where status = 'delivered';
-- 0
```

Zero rows, ever, across every provider (Yoola, Africa's Talking, LANA) — not a recent regression,
not provider-specific. The callback path is either never invoked or the providers never call it in
practice. `delivered` was structurally guaranteed to read 0 from the day that migration shipped.

## Fix

Per Josh: treat a provider-accepted send (`tenant_notification_log.status = 'sent'`) as delivered,
since a real handset-delivery confirmation is never coming. `20260917140000_sms_delivered_means_sent.sql`:

- `get_tenant_notification_performance` (5G) — `delivered` now equals `sent` in both `totals` and
  `by_event`. Dropped the now-unused `left join sms_delivery_log` from both CTEs.
- `get_tenant_channel_performance` (6M) — same fix in its `sms` CTE only. The `other` CTE (push /
  in-app, from `tenant_notification_deliveries`) is untouched — those channels do populate real
  `delivered`/`opened` statuses and were not part of this report.

No frontend change needed — `CTOCommunicationOverview.tsx`'s Tenant Notifications table and
`useTenantNotificationAnalytics.ts` just read whatever the RPC returns; the field name and shape
are unchanged, only its value.

## Separately noticed, not investigated here

The same screenshot shows `Failed` exceeding `Sent` for several events (e.g. "Rent limit
increased": Sent 36, Failed 84) and "Rent limit increased" also shows Suppressed 232 — far more
than Sent+Failed combined. These counts are mutually exclusive statuses on the same table over the
same date range, so a high failure/suppression rate relative to sent is plausible rather than
necessarily a bug, but it wasn't checked. Flagging for whoever looks at `RENT_LIMIT_INCREASED`
send volume next — don't assume it's fixed by this doc.

## Status — NOT YET APPLIED to production

Same as doc 55: attempted directly via `query_database`, blocked by the auto-mode classifier as a
shared-resource write. **Needs Josh to run `20260917140000_sms_delivered_means_sent.sql` by hand
via the Supabase SQL editor.** Until then, Delivered stays at 0 in the live dashboard.
