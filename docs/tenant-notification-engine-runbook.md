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

## Stage 4 — smartphone lifecycle and dashboard links

### The backfill decision (4A)

`profiles.has_smartphone` is **NOT NULL DEFAULT true**. Measured 2026-09-09:
61,961 true, 93 false, 0 null out of 62,054 live profiles. That `true` is
almost entirely the column default and carries no information — treating it as
a confirmation would have manufactured ~62,000 false confirmations and made
segmentation meaningless on day one.

So `true` backfilled to `UNKNOWN`. Only deliberate signals produced a
`CONFIRMED_FEATURE_PHONE`:

| Signal | Rows |
|---|---|
| `has_smartphone` actively set false against a true default | 93 profiles |
| `rent_requests.tenant_no_smartphone` flagged by an agent | 430 distinct tenants (624 requests) |

Starting at ~62k `UNKNOWN` is the truthful state, and is what
`SMARTPHONE_DISCOVERY` exists to resolve.

### Legacy sync

One trigger, deliberately asymmetric:

- **status → `has_smartphone`**: only for the two CONFIRMED states. `UNKNOWN`
  leaves the legacy flag untouched — mapping 62k rows to false would silently
  switch off every feature gated on `has_smartphone` (~195 references).
- **`has_smartphone` → status**: on UPDATE only, never INSERT. A deliberate
  edit is evidence; the insert default is not. This keeps `EditTenantDialog`
  working without the default leaking back in as a confirmation.

### What the link does and does not do (4C)

`welileapp.com/t/{token}` → `tenant-dashboard-open`. Only the SHA-256 hash of
the token is stored, so a database read cannot reproduce a working link, and
the tenant UUID never appears in the URL.

**It does not sign the tenant in.** The platform authenticates by OTP
(`otp_verifications`), and turning an SMS URL into a session would be a new
security posture for ~62k tenants — SMS forwarding, shared handsets and
browser history all leak URLs. The token proves *device capability* and records
engagement, which is what the lifecycle needs; balances still require the
existing OTP step. The endpoint returns no financial data, only a phone hint so
the page can start OTP for the right person. Invalid, expired and revoked
tokens all return the same shape, so it cannot be used to probe for live tokens.

If you want the link to auto-authenticate, that is a deliberate decision to
take separately — it is not implied by this stage.

Because only the hash is stored, an existing link can never be recovered and
re-sent, so each send mints a fresh token. Old tokens stay valid for 90 days,
so an older SMS still works.

### Device evidence (4D)

Only an **Android phone** or **iPhone** browser confirms a smartphone.
Everything else is logged as engagement but leaves `smartphone_status`
untouched, recorded via `counted_as_smartphone` so an audit can tell the
difference.

Verified against real user-agent strings:

| Open from | Classified | Confirms smartphone |
|---|---|---|
| Android phone Chrome / Samsung Internet | `android_phone` | Yes |
| iPhone Safari | `iphone` | Yes |
| Android tablet, iPad | `tablet` | No |
| Windows / macOS browser | `desktop` | No |
| WhatsApp, facebookexternalhit, curl | `bot` | No |
| Opera Mini, Nokia Series40 | `unknown` | No |

The preview bots matter most: WhatsApp and Facebook fetch every URL they are
sent, so a forwarded SMS link would otherwise confirm a smartphone the tenant
never touched. These links *will* get forwarded.

Device evidence outranks an agent's claim, so a phone open upgrades a profile
previously marked `CONFIRMED_FEATURE_PHONE`; the access log keeps the
contradiction visible.

### Senders

```bash
# 4F — resolve UNKNOWN tenants
curl -sX POST "$SUPABASE_URL/functions/v1/tenant-dashboard-invites" \
  -H "Content-Type: application/json" -H "apikey: $ANON_KEY" \
  -d '{"mode":"discovery","dry_run":true}'

# 4G — confirmed smartphone, never activated
curl -sX POST "$SUPABASE_URL/functions/v1/tenant-dashboard-invites" \
  -H "Content-Type: application/json" -H "apikey: $ANON_KEY" \
  -d '{"mode":"invite","dry_run":true}'

# 4H — call-centre single send
curl -sX POST "$SUPABASE_URL/functions/v1/tenant-dashboard-invites" \
  -H "Content-Type: application/json" -H "apikey: $ANON_KEY" \
  -d '{"tenant_id":"<uuid>","mode":"invite"}'
```

A dry run renders `/t/<token>` as a literal placeholder — it must not mint real
credentials.

`DASHBOARD_ACTIVATED` fires from `tenant-dashboard-open` on a first open that
is *also* smartphone evidence, keyed `episodeKey: "activated"` so it sends
once ever, not once per day. A preview bot's fetch is logged but never
triggers a welcome.

### Handed to Gemini

The backend is complete; three pieces of UI are not mine to build:

- the `/t/:token` landing page, which POSTs the token to
  `tenant-dashboard-open` and then runs the existing OTP flow
- the Yes / No / **Unknown** radio in the tenant registration form, posting
  `smartphone_answer` to `submit-tenant-form` (the endpoint already accepts it
  and still honours the legacy `no_smartphone` boolean)
- the call-centre panel: status, source, dashboard state, and the four actions.
  `[Confirm Smartphone]` / `[Feature Phone]` / `[Keep Unknown]` call
  `set_tenant_smartphone_status`; `[Send Dashboard Link]` calls
  `tenant-dashboard-invites` with `{tenant_id}`. It must not carry its own SMS
  copy.

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
-- Smartphone discovery: Wed 09:00 Kampala. Marketing-capped, so this competes
-- with relocation for the tenant's two weekly slots.
select cron.schedule(
  'tenant-smartphone-discovery',
  '0 6 * * 3',
  $$select net.http_post(
      url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-dashboard-invites',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{"mode":"discovery"}'::jsonb
  );$$
);

-- Dashboard invite: Mon 09:00 Kampala.
select cron.schedule(
  'tenant-dashboard-invite',
  '0 6 * * 1',
  $$select net.http_post(
      url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-dashboard-invites',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{"mode":"invite"}'::jsonb
  );$$
);

-- Attribution sweep (Stage 5): hourly. Idempotent, cheap when nothing new
-- matches — see "Two attribution paths, not one" above.
select cron.schedule(
  'tenant-notification-attribution',
  '20 * * * *',
  $$select net.http_post(
      url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-notification-attribution',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb
  );$$
);

-- Push migration (Stage 6K): weekly, Wed 09:00 Kampala. Low volume by
-- design (only confirmed-smartphone, dashboard-activated, no-push-yet
-- tenants), so daily would just be noise.
select cron.schedule(
  'tenant-push-migration-notices',
  '0 6 * * 3',
  $$select net.http_post(
      url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-push-migration-notices',
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

## Stage 5 — measurement and attribution

Two RPCs, both SQL-aggregated (no row set for the frontend to reduce), and
`src/hooks/useTenantNotificationAnalytics.ts` as thin typed fetchers. The
cards/charts consuming them are Gemini's.

```sql
select get_tenant_smartphone_overview();
select get_tenant_smartphone_overview(p_district := 'Kampala');
select get_tenant_notification_performance(current_date - 6, current_date);
select get_tenant_notification_performance(current_date - 6, current_date, 'PAYMENT_MISSED');
```

Filters implemented now: `district` and `agent_id` (resolved through the
tenant's currently active Rent Plan) on the smartphone overview; `district`
and `event_key` on notification performance. The rest of the list from the
brief — sub-agent, days overdue, payment behaviour, Rent Plan status — is not
wired; each needs its own join and was left out rather than half-built.

### Two attribution paths, not one

**Deterministic** — a dashboard link now remembers which SMS minted it
(`tenant_dashboard_links.notification_log_id`, attached by
`attach_notification_to_dashboard_link` right after `notifyTenant` returns a
send). When the tenant opens it, `record_tenant_dashboard_access` stamps
`acted_at` on that exact log row — not "the most recent send to this tenant",
which was always an approximation. The gate is `device_class <> 'bot'`
(genuine engagement), which is *wider* than smartphone confirmation
(`android_phone`/`iphone` only): a desktop open is not smartphone evidence,
but it is a real person acting on the SMS.

**Correlational** — `MERCHANT_CODE_REMINDER` and `FIVE_DAY_AGENT_OPPORTUNITY`
have no tracked link, so there is no deterministic path. Both are bounded
observations, reported as *"payment after reminder"* / *"became agent after
opportunity SMS"* — never *"caused by"*. Backfilled by
`attribute_tenant_notification_actions`, wrapped in the
`tenant-notification-attribution` edge function:

```bash
curl -sX POST "$SUPABASE_URL/functions/v1/tenant-notification-attribution" \
  -H "Content-Type: application/json" -H "apikey: $ANON_KEY" \
  -d '{"lookback_days":14,"merchant_window_hours":24}'
```

| Event | Match | Window |
|---|---|---|
| `MERCHANT_CODE_REMINDER` | an `agent_collections` row for the same tenant, `amount > 0`, **not** `notes ILIKE '%[REVERSED:%'** | 24h after send (configurable) |
| `FIVE_DAY_AGENT_OPPORTUNITY` | a `user_roles` row for `agent`/`sub_agent`, enabled, `created_at` strictly after the send | none — registering is not instant |

Idempotent: only `acted_at is null` rows are scanned, and the write itself is
guarded the same way, so re-running (by hand or on a schedule) never
double-attributes. Verified against production before trusting the join
logic: the `[REVERSED:` marker matches the one reversed collection that
exists, and `user_roles(role='agent')` timestamps are genuinely distinct
(61,857 rows, Dec 2025–Sep 2026, no backfill artifact that would fabricate a
conversion). This sweep is unscheduled, same as every sender — call it by hand
or add a cron once you're ready.

### What "delivered" means

`get_tenant_notification_performance`'s `delivered` figure comes from
`sms_delivery_log.status = 'delivered'`, populated only by Africa's Talking's
delivery-report callback (`sms-delivery-report`). Yoola and LANA don't confirm
handset delivery, so their rows stay `sent` (accepted by the provider) and are
counted as sent, not delivered — an undercount for non-AT sends, never an
overclaim.

### Two bugs caught building this stage

Both **`set_tenant_smartphone_status`** (Stage 4) and **`payment_channels`**'s
write policy (Stage 3) called `has_role(..., 'call_centre')` and
`has_role(..., 'finance')`. `has_role`'s second argument is a strict `app_role`
enum with no such members — the real values are `crm` (this codebase's
call-centre role; see `crm-place-call`, `crm-voice-callback`) and
`financial_ops`. Since the literal has to resolve to the enum type at parse
time, every call would have failed, not just the branch that reached it.
Fixed in place in the original migration files, since neither had ever
executed. Caught by diffing every `has_role(...)` literal in these migrations
against the live `app_role` enum — worth repeating for any future migration
that adds a role check.

## Stage 6 — multi-channel routing (SMS / push / in-app)

### Correction before anything else

The brief called for Firebase/FCM and new `tenant_push_devices` /
`tenant_in_app_notifications` tables. **This codebase has no Firebase
anywhere.** Push was already a complete, working implementation: VAPID Web
Push (`push_subscriptions`: endpoint/p256dh/auth), full RFC 8291/8188
aes128gcm encryption in `send-push-notification`, a registered `/sw.js`, and
an existing UI trigger (`PushNotificationButton.tsx`). There is also already
a generic in-app inbox (`notifications`: user_id/title/message/type/
metadata/is_read), already written to by several other edge functions.

Building the brief's new tables and an FCM sender would have been exactly the
"two independent copies of the same fact" trap this codebase keeps getting
bitten by (see the merchant OOP settlement RPC, the missed-days functions).
So Stage 6 **extends** `push_subscriptions` and `notifications` additively
instead — no RLS change, no constraint change, existing readers/writers of
either table are unaffected — and reuses the existing VAPID crypto rather
than adding a vendor dependency that isn't there. The VAPID encryption/JWT
code was *moved* (not copied) into `_shared/webPushSend.ts`, and
`send-push-notification/index.ts` now imports it — same behaviour, same
contract, one implementation instead of a second one that could drift.

### Architecture

```
Business Event -> routeTenantNotification() -> policy lookup
                                              -> SMS  (existing notifyTenant, unchanged)
                                              -> Push (webPushSend, per active device)
                                              -> In-app (notifications inbox)
```

One event, one call site (`_shared/tenantChannelRouter.ts`), channel-specific
rendering. SMS still runs through the existing `notifyTenant()` — that path
already owns the frequency governor, episode idempotency and
`sms_delivery_log` linkage proven across Stage 1–5; reimplementing it here
would reopen the exact drift this project has spent five stages avoiding.

`tenant_notification_channel_policy` decides per event:

| Column | Meaning |
|---|---|
| `critical` | Financial/contractual. SMS always attempted regardless of push. Ignores the tenant's marketing opt-out. |
| `push_preferred` | When true AND the tenant has an active device AND `push_enabled`, SMS is **skipped** — push+in-app carry it instead. This is the brief's "conditional SMS". |
| `sms_fallback` | Only relevant when `push_preferred` skipped SMS and every device attempt failed. Sent once, synchronously (Web Push has no async delivery-failure callback the way Africa's Talking's DLR does, so failure is already known at send time). |

Seeded: all five payment/limit-increase/five-day/merchant-code events are
`critical` (every channel fires, always — "do not migrate these fully off
SMS yet"). Relocation and rent-limit-progress are `push_preferred` (push once
a device exists, SMS only for tenants push can't reach). Dashboard-invite and
smartphone-discovery have push/in-app **disabled outright** — by definition
the tenant has no confirmed device or has never opened the dashboard, so
neither channel could do anything. Dashboard-activated is `push_preferred` +
`sms_fallback` (a tenant proving smartphone capability on THIS visit
overwhelmingly has no push token yet, so the fallback is the common case, not
the exception).

A tenant's own preference (`tenant_notification_preferences`) is **one**
toggle — `marketing_push_opt_out` — not four. Stage 6L is explicit that
critical/contractual communication must not become suppressible because
promotional push is off, and a switch that looked like it controlled
"payment updates" while being silently ignored for critical events would be
worse than not offering it. SMS opt-out remains the separate, existing
`sms_opt_outs` table.

### Two bugs caught while building this, not before

- **A phone-less tenant with SMS "wanted" by policy could never reach
  in-app.** The router's original branching returned early whenever it
  didn't attempt SMS, even when in-app needed no phone number at all.
  Fixed by separating "policy wants SMS" (`wantSmsInitially`) from "SMS will
  actually be attempted" (`willAttemptSms = wantSmsInitially && phone`) — a
  missing phone now falls through to push/in-app instead of dead-ending.
- **The `sms_fallback` path could silently send an empty SMS.** The
  configuration guard ("every event needs a body_template or fail loudly")
  was scoped to the primary SMS branch only; the fallback branch, reached by
  the *opposite* condition, wasn't covered by it. Fixed by broadening the
  guard to `policy.sms_enabled` generally. Not a live bug — the one seeded
  event with `sms_fallback=true` has copy — but a latent one for any future
  event configured the same way.

### Senders retrofitted

All nine SMS call sites across the eight existing senders now call
`routeTenantNotification()` instead of `notifyTenant()` directly:
`tenant-payment-notices` (×3), `tenant-default-agent-opportunity`,
`tenant-relocation-notices`, `tenant-rent-limit-notices` (×2),
`tenant-merchant-code-notices`, `tenant-dashboard-invites`,
`tenant-dashboard-open`. Behaviour is unchanged for events with push/in-app
disabled in policy (dashboard-invite, smartphone-discovery) — this was a
safe, mechanical swap for those two specifically, verified by checking their
policy row resolves to SMS-only.

### `tenant-push-migration-notices` — Stage 6K

Deliberately narrow: `get_tenant_push_migration_candidates` targets only
`CONFIRMED_SMARTPHONE` tenants whose dashboard is already activated **and**
who have zero active push subscriptions. Excludes feature-phone, `UNKNOWN`,
dashboard-inactive, and already-push-enabled tenants outright — that's what
makes it a targeted migration rather than another mass SMS. Mints a fresh
per-tenant dashboard link the same way `tenant-dashboard-invites` does.

```bash
curl -sX POST "$SUPABASE_URL/functions/v1/tenant-push-migration-notices" \
  -H "Content-Type: application/json" -H "apikey: $ANON_KEY" \
  -d '{"dry_run":true}'
```

### Reading channel performance (6M)

`get_tenant_channel_performance` unions SMS facts (already in
`tenant_notification_log`/`sms_delivery_log`) with push/in-app facts
(`tenant_notification_deliveries`) **at query time** — SMS never gets a
synthetic row written into `tenant_notification_deliveries`, so one business
event delivered over three channels is three rows in the report, never three
notifications counted against the tenant (6N).

```sql
select get_tenant_channel_performance(current_date - 6, current_date);
select get_tenant_channel_performance(current_date - 6, current_date, 'PAYMENT_MISSED');
```

### What's Gemini's

- The in-app inbox UI (`useTenantInAppNotifications.ts` has the reads/writes;
  no bell icon or list view exists yet).
- The notification-preference toggle UI
  (`useTenantNotificationPreferences.ts` has the read/write).
- Nothing new needed for push *subscription* itself — `PushNotificationButton.tsx`
  and `src/lib/webPush.ts` already handle permission + subscribe + save, and
  are unchanged by this stage.

## Catalogue status

| Event key | Class | Channels (policy) | Sender | Built |
|---|---|---|---|---|
| `PAYMENT_FULL` | transactional | SMS+push+in-app, critical | `tenant-payment-notices` (payments) | Yes |
| `PAYMENT_PARTIAL` | transactional | SMS+push+in-app, critical | `tenant-payment-notices` (payments) | Yes |
| `PAYMENT_MISSED` | transactional | SMS+push+in-app, critical | `tenant-payment-notices` (missed) | Yes |
| `FIVE_DAY_AGENT_OPPORTUNITY` | transactional | SMS+push+in-app, critical | `tenant-default-agent-opportunity` | Yes |
| `TENANT_RELOCATION` | marketing | SMS conditional, push+in-app preferred | `tenant-relocation-notices` | Yes |
| `RENT_LIMIT_INCREASED` | transactional | SMS+push+in-app, critical | `tenant-rent-limit-notices` (increased) | Yes |
| `RENT_LIMIT_PROGRESS` | marketing | SMS conditional, push+in-app preferred | `tenant-rent-limit-notices` (progress) | Yes |
| `MERCHANT_CODE_REMINDER` | transactional | SMS+push+in-app, critical | `tenant-merchant-code-notices` | Yes |
| `DASHBOARD_INVITE` | marketing | SMS only | `tenant-dashboard-invites` (invite) | Yes |
| `SMARTPHONE_DISCOVERY` | marketing | SMS only | `tenant-dashboard-invites` (discovery) | Yes |
| `DASHBOARD_ACTIVATED` | transactional | SMS fallback, push+in-app preferred | `tenant-dashboard-open` | Yes |
| `PUSH_MIGRATION` | transactional | SMS only, in-app optional | `tenant-push-migration-notices` | Yes |

## Not built yet

- **Stage 5 UI** — the actual Tenant Ops cards/charts. The RPCs and hooks
  exist (`get_tenant_smartphone_overview`, `get_tenant_notification_performance`,
  `get_tenant_channel_performance`, `useTenantNotificationAnalytics.ts`); the
  page markup is Gemini's.
- **Stage 5 filters not yet wired**: sub-agent, days-overdue, payment
  behaviour, Rent Plan status. District and agent are wired.
- **In-app inbox UI and preference-toggle UI** — the reads/writes exist
  (`useTenantInAppNotifications.ts`, `useTenantNotificationPreferences.ts`);
  no bell icon, list view or settings screen exists yet. Gemini's.
- **Gemini's three Stage 4 UI pieces**, listed under Stage 4 above.

## Known dead code

`increase_limit_on_timely_payment()` writes to a `loan_limits` table that does
not exist in production and is attached to no trigger. It is not a live fault,
but anyone tracing how rent-access limits change will find it and be misled —
`credit_access_limits` + `recalculate_credit_limit()` is the real path.
