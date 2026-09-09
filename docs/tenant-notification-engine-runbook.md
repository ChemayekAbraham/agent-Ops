# Tenant notification engine — runbook

Behaviour-driven tenant SMS from the 2026-09-06 and 2026-09-09 tenant-ops
meetings. This document covers what is live, how to dry-run each sender, and
how to switch each one on.

**Nothing in this engine is scheduled.** The senders deploy inert on purpose:
each one changes what thousands of tenants receive, so switching one on is an
explicit decision with a measured recipient count behind it, not a side effect
of a deploy. Cron statements to enable them are at the bottom.

## Components

| Piece | What it does |
|---|---|
| `tenant_notification_events` | Event catalog. `message_class` decides the frequency regime; `link_path` keeps SPA routes out of sender code. |
| `tenant_notification_settings` | Global marketing cap (default 2 / rolling 7 days), tunable without a deploy. |
| `tenant_notification_log` | Unique episode index = once-per-occasion idempotency. `acted_at` / `action` measure what tenants did *after* an SMS. |
| `can_send_tenant_notification` | Frequency governor. Does **not** check opt-outs — `sendSmsMultiProvider` already gates every send on `sms_opt_outs` and `sms_message_exceptions`. |
| `_shared/tenantNotify.ts` | The only way a tenant behaviour SMS should be sent. Governor → send → log, including logging skips. |

### Frequency regimes

The two meetings asked for both "daily SMS" and "twice per week". Both are
honoured by splitting on `message_class`:

- **transactional** — event-driven, may fire daily. Payment received, partial
  payment, missed payment, five-day default.
- **marketing** — value-proposition copy, sharing a global cap of twice per
  rolling 7 days. Relocation, rent-access progress, dashboard link.

The marketing cap is global rather than per-event on purpose: eight marketing
events capped at twice each would be sixteen SMS a week.

## Senders

### `tenant-payment-notices` — mode `payments`

Sweep for tenants who just paid. Sends `payment_received` when the day's
obligation is cleared, `payment_partial` when it is not. Episode key is the
obligation day, so a tenant who pays repeatedly gets at most one partial and
one cleared message — and a partial that later completes still earns the
cleared confirmation.

Runs as a short sweep rather than a trigger on `agent_collections`: that table
is written by four SECURITY DEFINER money RPCs, and hanging outbound HTTP off a
money-write path is not worth trading for a few minutes of latency. Cost is up
to one sweep interval of delay.

```bash
# dry run — shows recipients and exact message text, sends nothing
curl -sX POST "$SUPABASE_URL/functions/v1/tenant-payment-notices" \
  -H "Content-Type: application/json" -H "apikey: $ANON_KEY" \
  -d '{"mode":"payments","since_minutes":1440,"dry_run":true}'
```

### `tenant-payment-notices` — mode `missed`

Daily, after the obligation day closes. Defaults to *yesterday*: today is still
in progress, and a tenant who has not paid yet this morning has missed nothing.

Two volume guards, both measured against production on 2026-09-09. 551 tenants
had an unpaid obligation for the previous day; messaging all of them daily
would mean a permanent daily SMS to people not participating at all.

| Guard | Default | Effect |
|---|---|---|
| `require_prior_payment` | `true` | Drops 59 who have never paid anything. "You missed today's payment" is the wrong first message for someone who never started. |
| `max_days_since_last_payment` | `30` | Drops a further 136 dormant tenants. They belong on a call-centre list, not a daily SMS loop. |

Net daily population: **356**, not 551.

```bash
curl -sX POST "$SUPABASE_URL/functions/v1/tenant-payment-notices" \
  -H "Content-Type: application/json" -H "apikey: $ANON_KEY" \
  -d '{"mode":"missed","dry_run":true}'
```

### `tenant-default-agent-opportunity`

Five consecutive missed days → Welile agent earnings offer. Once per default
episode, never daily after day five.

`EPISODE_START_FLOOR` in the function defaults to `2026-09-09` and is the
launch guard. Measured on 2026-09-09, an unguarded rule would have messaged
**558** tenants on its first run, but only ~38 were genuine fresh defaults
(run 5–6, average 4 days since last payment). Of the rest, 351 had missed the
entire 30-day window (averaging 37 days since any payment) and 57 had never
paid at all. A `MAX_RUN` of 7 stops anyone 30 days into default being told
"5 days", which would be plainly untrue.

With both guards, the live candidate set was **47**.

```bash
curl -sX POST "$SUPABASE_URL/functions/v1/tenant-default-agent-opportunity" \
  -H "Content-Type: application/json" -H "apikey: $ANON_KEY" \
  -d '{"dry_run":true}'
```

To deliberately backfill historical episodes, pass
`{"episode_start_on_or_after": null, "max_run": null}` — but read the numbers
above first.

## Day-attribution fix

`get_tenant_missed_dates` / `get_tenant_missed_days` bucketed payments by UTC
date while `get_tenant_repayment_reliability` used `Africa/Kampala`. Since
Kampala is UTC+3, a payment made between 00:00 and 03:00 local landed on the
previous UTC day: the tenant paid, but the day was still counted as missed.

Measured on 2026-09-09: 84 of 8,728 collections over the trailing 90 days
(0.96%), touching 69 tenants. Low volume, but these functions now drive
tenant-facing SMS and the five-day trigger, so a false missed day becomes a
false accusation. Both are corrected to `Africa/Kampala`.

The fix can only remove false missed days, never add one, so counts move
slightly in the tenant's favour. Repo callers were one UI read
(`DailyCollectionMonitoringDashboard`) and this engine; no database function
referenced either.

## Enabling the schedules

Run in the SQL editor once ops has reviewed the dry-run output. Times are UTC;
Kampala is UTC+3, no DST.

```sql
-- Payment received / partial: every 15 minutes.
select cron.schedule(
  'tenant-payment-notices-sweep',
  '*/15 * * * *',
  $$select net.http_post(
      url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-payment-notices',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{"mode":"payments","since_minutes":20}'::jsonb
  );$$
);

-- Missed payment: 09:00 Kampala.
select cron.schedule(
  'tenant-payment-notices-missed',
  '0 6 * * *',
  $$select net.http_post(
      url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-payment-notices',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{"mode":"missed"}'::jsonb
  );$$
);

-- Five-day default agent opportunity: 10:00 Kampala.
select cron.schedule(
  'tenant-default-agent-opportunity',
  '0 7 * * *',
  $$select net.http_post(
      url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-default-agent-opportunity',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb
  );$$
);
```

The sweep interval and `since_minutes` should overlap (15 vs 20 above) so a
slow run cannot drop a payment between windows. Duplicates are harmless — the
episode index absorbs them.

To stop a sender: `select cron.unschedule('<job-name>');`. To silence one
without touching cron:
`update tenant_notification_events set active = false where event_key = '...';`

## Checks

```sql
-- Sends and skips by event, last 7 days.
select l.event_key, l.status, coalesce(l.skip_reason,'-') as reason, count(*)
from tenant_notification_log l
where l.created_at >= now() - interval '7 days'
group by 1,2,3 order by 1,2,4 desc;

-- Anyone receiving more marketing than the cap allows (should return nothing).
select l.tenant_id, count(*) as marketing_7d
from tenant_notification_log l
join tenant_notification_events e on e.event_key = l.event_key
where l.status = 'sent' and e.message_class = 'marketing'
  and l.created_at >= now() - interval '7 days'
group by 1
having count(*) > (select marketing_max_per_week from tenant_notification_settings where id = 1);
```

## Not built yet

- Smartphone lifecycle (`smartphone_status` / `_source` / `_verified_at`) and
  dashboard-access tracking. `profiles.has_smartphone` is currently a bare
  boolean with ~195 references, so the lifecycle has to be added alongside it
  and kept in sync, not swapped in.
- The per-tenant dashboard link. `/dashboard/tenant` is an authenticated SPA
  route and `agent_form_tokens` is agent-scoped, so there is no per-tenant link
  to instrument yet — it has to be built before a link-open can confirm
  smartphone ownership.
- `relocation_proposition`, `rent_access_progress`, `merchant_code_payment`
  and `dashboard_link` senders. Their catalog entries and caps exist; the
  senders do not.
- Ops dashboards for smartphone segmentation and SMS performance.
