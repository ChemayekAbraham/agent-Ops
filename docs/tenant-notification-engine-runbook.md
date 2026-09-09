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

### `tenant-relocation-notices` — Stage 3A

`TENANT_RELOCATION`. The proposition the 2026-09-09 review found unimplemented.
Deliberately not conditional on defaulting — it goes to active tenants (683 as
of 2026-09-09).

Frequency is **not** enforced in the sender. The event is `marketing`, so the
governor applies the global twice-per-week cap across all proposition copy.
Schedule it twice weekly and let the governor arbitrate: if another campaign
already used a tenant's two slots, this one yields instead of stacking.

```bash
curl -sX POST "$SUPABASE_URL/functions/v1/tenant-relocation-notices" \
  -H "Content-Type: application/json" -H "apikey: $ANON_KEY" \
  -d '{"dry_run":true}'
```

### `tenant-rent-limit-notices` — Stage 3B

Two events, because the system must never claim a limit rose when it did not.

`mode=increased` reads `credit_limit_change_log`, populated by an
`after update` trigger on `credit_access_limits` that fires only when
`total_limit` actually changes. The figure in the SMS is the stored new limit.
Each change row is stamped `notified_at`, so one real increase yields exactly
one message even if the notification log is later pruned.

`mode=progress` is the honest alternative for tenants who paid well but whose
limit did not move: it says the record is strengthening and claims nothing
about a change. Classified `marketing`, so it competes for the twice-weekly
budget rather than firing on every payment. Tenants whose limit *did* rise are
excluded — they get `RENT_LIMIT_INCREASED` instead.

Before this, "the limit actually increased" was not an answerable question:
`credit_access_limits` (57,205 rows, 2,228 updated in the trailing 30 days)
keeps no history, so the event could only have been inferred from a payment —
exactly the false claim to avoid.

```bash
curl -sX POST "$SUPABASE_URL/functions/v1/tenant-rent-limit-notices" \
  -H "Content-Type: application/json" -H "apikey: $ANON_KEY" \
  -d '{"mode":"increased","dry_run":true}'
```

### `tenant-merchant-code-notices` — Stage 3C

`MERCHANT_CODE_REMINDER`. Goes to tenants carrying an unpaid or partly-paid
obligation for the day, so the instruction lands when it is useful.

Codes come from `payment_channels`, seeded from the values previously hardcoded
in `src/components/payments/DepositFlow.tsx` (MTN `090777`, Airtel `4380664`).
The sender **refuses to send** (409) when no channel is active rather than
transmitting "using MTN  or Airtel ." — an SMS quoting a stale or empty
merchant code sends money to the wrong place.

Also supports a call-centre single send: pass `{"tenant_id":"<uuid>"}`.

```bash
curl -sX POST "$SUPABASE_URL/functions/v1/tenant-merchant-code-notices" \
  -H "Content-Type: application/json" -H "apikey: $ANON_KEY" \
  -d '{"dry_run":true}'
```

## Copy and configuration

SMS wording lives in `tenant_notification_events.body_template`, editable
without a deploy. Placeholders use `{{double_brace}}`, matching
`tenant_message_templates` (the catalogue drafts used single braces).

A placeholder with no value is **removed**, not left in the message — an SMS
reading `View: {{dashboard_link}}` is worse than one with no link. Per-tenant
dashboard links do not exist until Stage 4C, so `{{dashboard_suffix}}` renders
empty and those messages simply end after the balance.

To change wording:

```sql
update tenant_notification_events
set body_template = 'Welile: ...', updated_at = now()
where event_key = 'TENANT_RELOCATION';
```

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

-- Rent-limit increases: hourly. Cheap when the change log is empty, and a
-- tenant hears about a raised limit the same day it happens.
select cron.schedule(
  'tenant-rent-limit-increased',
  '15 * * * *',
  $$select net.http_post(
      url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-rent-limit-notices',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{"mode":"increased"}'::jsonb
  );$$
);

-- Relocation proposition: Tue & Fri 09:00 Kampala. The governor still enforces
-- the global marketing cap, so this schedule is a ceiling, not a guarantee.
select cron.schedule(
  'tenant-relocation-notices',
  '0 6 * * 2,5',
  $$select net.http_post(
      url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-relocation-notices',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb
  );$$
);

-- Merchant-code reminder: 16:00 Kampala, late enough that the day's agent
-- collection round has usually happened.
select cron.schedule(
  'tenant-merchant-code-notices',
  '0 13 * * *',
  $$select net.http_post(
      url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-merchant-code-notices',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb
  );$$
);
```

`RENT_LIMIT_PROGRESS` is intentionally left unscheduled even here: it competes
for the same marketing budget as relocation, and running both means one
silently starves the other. Pick one to schedule, or raise
`tenant_notification_settings.marketing_max_per_week` deliberately.

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

## Catalogue status

| Event key | Class | Sender | Built |
|---|---|---|---|
| `PAYMENT_FULL` | transactional | `tenant-payment-notices` (payments) | Yes |
| `PAYMENT_PARTIAL` | transactional | `tenant-payment-notices` (payments) | Yes |
| `PAYMENT_MISSED` | transactional | `tenant-payment-notices` (missed) | Yes |
| `FIVE_DAY_AGENT_OPPORTUNITY` | transactional | `tenant-default-agent-opportunity` | Yes |
| `TENANT_RELOCATION` | marketing | `tenant-relocation-notices` | Yes |
| `RENT_LIMIT_INCREASED` | transactional | `tenant-rent-limit-notices` (increased) | Yes |
| `RENT_LIMIT_PROGRESS` | marketing | `tenant-rent-limit-notices` (progress) | Yes |
| `MERCHANT_CODE_REMINDER` | transactional | `tenant-merchant-code-notices` | Yes |
| `DASHBOARD_INVITE` | marketing | — | Stage 4 |
| `SMARTPHONE_DISCOVERY` | marketing | — | Stage 4 |
| `DASHBOARD_ACTIVATED` | transactional | — | Stage 4 |
| `PUSH_MIGRATION` | transactional | — | Stage 6 |

## Not built yet

- **Stage 4A–4E: smartphone lifecycle and dashboard tracking.**
  `profiles.has_smartphone` is a bare boolean with ~195 references, so
  `smartphone_status` / `_source` / `_verified_at` must be added alongside it
  and kept in sync, not swapped in.
- **The per-tenant dashboard link**, which Stage 4C depends on.
  `/dashboard/tenant` is an authenticated SPA route and `agent_form_tokens` is
  agent-scoped, so there is nothing to instrument yet. The four Stage 4 events
  above have catalog rows and copy but cannot send until the link exists —
  their templates all require `{{dashboard_link}}`.
  When it is built, device gating applies: a link opened from an Android or
  iOS mobile browser is evidence of smartphone access; one opened from
  desktop, a tablet, a crawler or a WhatsApp preview bot is **not**, and must
  leave the status `UNKNOWN`.
- **Stage 5: ops dashboards** for smartphone segmentation and SMS performance.
- **Stage 6: push/in-app migration.** SMS stays the channel for payment and
  security events; push takes engagement and proposition copy.

## Known dead code

`increase_limit_on_timely_payment()` writes to a `loan_limits` table that does
not exist in production and is attached to no trigger. It is not a live fault,
but anyone tracing how rent-access limits change will find it and be misled —
`credit_access_limits` + `recalculate_credit_limit()` is the real path.
