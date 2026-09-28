# Tenant Ops Workspace — Findings

Investigation only, per `docs/TOPS_RULES.md`. Every fact below was checked
directly against the live production database (project `43e6c2e1-18a6-4503-badb-5bb6c23491cc`)
on 2026-09-26, not inferred from migration files alone — this repo's own
CLAUDE.md warns that `supabase/migrations/` does not faithfully reflect the
live schema, and that warning was confirmed true multiple times below.
Where something could not be confirmed, it is marked **UNKNOWN**.

---

## 1. Schedule — how a plan's repayment schedule is derived today

**`v_rent_plan_schedule`** (view, confirmed live). Columns: `rent_request_id,
agent_id, tenant_id, daily_amount, total_amount, amount_repaid, term_start,
term_end, term_days, obligation_end, oblig_days, is_live, last_pay_date`.

- **`term_start` comes from**: `COALESCE(rr.repayment_starts_on, (COALESCE(rr.funded_at, rr.disbursed_at, rr.created_at) AT TIME ZONE 'Africa/Kampala')::date)`.
  `rent_requests.repayment_starts_on` is a plain, directly-editable `date`
  column — **yes, it can be back-dated or forward-dated**: it is just a date
  value on the row, set at registration/approval time and changeable by any
  code path with UPDATE rights on `rent_requests` (no trigger or check
  constraint protects it). It is the single authoritative anchor for "when
  does this plan's repayment clock start" platform-wide as of today
  (confirmed also used this way in `pin_agent_expected_day`,
  `rent_plan_schedule_days`, and — after a fix applied this session,
  2026-09-26 — `v_tenant_daily_eligibility`/`v_tenant_ops_tenant_base`/
  `v_cc_tenant_calling_population`, see §6).
- `term_end = term_start + duration_days - 1`.
- `is_live = status IN ('funded','repaying') AND (total_repayment - amount_repaid) > 0`.
- The view additionally gates on landlord-disbursement evidence (see §4) via
  a `landlord_evidence` CTE joined against `agent_landlord_float_allocations`
  — a plan with `total_repayment - amount_repaid > 0` but landlord evidence
  still open (`status='open'`) and nothing repaid yet is excluded from the
  view entirely (`is_live` never becomes true for it via this WHERE clause).

**`rent_plan_schedule_days(p_from date, p_to date)`** (function, confirmed
live). Its own header comment (still present in the live body) calls it the
canonical instalment generator. It reads `v_rent_plan_schedule` joined to
`rent_requests.repayment_frequency` and expands into one row per instalment
due date:
- `daily`: one row per day, amount = `daily_amount`.
- `weekly`: one row every 7 days from `term_start`, amount = `daily_amount * 7`.
- `monthly`: one row every calendar month from `term_start`, amount = `daily_amount * 30`.
- Every instalment amount is `LEAST(instalment*(k+1), total_amount) - LEAST(instalment*k, total_amount)` —
  i.e. the schedule is self-capping at `total_amount`, so the last instalment
  is a partial top-off rather than overshooting.

**`agent_expected_day_plans`** (table, confirmed live). Columns: `day (date, NOT NULL),
rent_request_id (uuid, NOT NULL), agent_id, tenant_id, expected_ugx (numeric, NOT NULL),
captured_at (timestamptz, NOT NULL)`. Primary key `(day, rent_request_id)`. Populated
by `pin_agent_expected_day(p_day)` from `rent_plan_schedule_days()`, `ON CONFLICT (day, rent_request_id) DO NOTHING`
— **write-once per day per plan**, so once a day is pinned its expected amount
never moves even if the plan is edited afterward. `pin_agent_expected_day` refuses
to pin before `rent_arrears_go_live()` (`2026-09-10`, a hardcoded `IMMUTABLE` function)
or after today. Weekly plans get exactly **one** pinned row on their due day at
the full weekly amount — not spread across 7 daily rows (this was a real past
incident, fixed 2026-09-09, per `supabase/migrations/20260909210000_weekly_instalment_only_on_its_due_day.sql`).

---

## 2. Is there already a day-settlement / arrears-attribution engine?

**Yes.** Every object below is confirmed live:

| Object | Kind | Role |
|---|---|---|
| `agent_expected_day_plans` | table | the pinned daily/weekly bill (§1) |
| `rent_day_settlements` | table (`id, rent_request_id, day, collection_id, amount, created_at`) | which collection paid which day, FIFO-attributed |
| `v_rent_day_ledger` | view (`rent_request_id, day, agent_id, tenant_id, expected_ugx, settled_ugx, remaining_ugx, is_settled`) | expected vs settled per plan per pinned day, floored at `rent_arrears_go_live()` |
| `v_rent_plan_arrears` | view (`rent_request_id, agent_id, tenant_id, days_billed, days_behind, arrears_ugx, due_today_ugx, billed_to_date_ugx, settled_to_date_ugx, oldest_open_day`) | per-plan rollup of the ledger |
| `agent_collect_context(p_rent_request_id)` | function | one-call combined read (`expected_today, days_behind, arrears_ugx, oldest_open_day, due_today_ugx, unapplied_ugx, behind_days[]`) |
| `rent_apply_collections_to_days(p_rent_request_id)` | function | the FIFO waterfall: matches unapplied `agent_collections` funds against open `agent_expected_day_plans` days, in `created_at` order, and (re)writes `rent_day_settlements` |
| `rent_sweep_unapplied_collections()` | function, cron **`sweep-unapplied-rent-collections-eat-midnight`**, schedule `10 21 * * *` (00:10 EAT) | nightly re-run of the waterfall for every plan with unapplied funds |
| `v_rent_collection_unapplied` | view | collected-but-not-yet-day-attributed money per plan (feeds the sweep above) |
| `pin_agent_expected_day_catchup()` | function, cron **`pin-agent-expected-day-eat-midnight`**, schedule `5 21 * * *` (00:05 EAT) | pins each day's bill shortly after Kampala midnight |

**Does it handle WEEKLY plans, or daily only?** It handles both, but with a
naming caveat worth flagging precisely: `rent_plan_schedule_days()` already
bills weekly plans correctly (one instalment every 7 days, full weekly
amount — §1). But `v_rent_plan_arrears.days_billed` / `days_behind` count
**pinned rows**, not calendar days. For a weekly plan, one pinned row = one
week. So "days_behind = 2" for a weekly tenant means **2 unpaid weekly
instalments**, not 2 calendar days — the column name says "days" but the
unit is "instalments" for a non-daily plan. This is not a bug, but a new
reader must not treat `days_behind` as a literal day count for weekly plans
without converting.

---

## 3. Cadence — how is a plan known to be daily or weekly?

`rent_requests.repayment_frequency` (`text`, `NOT NULL DEFAULT 'daily'`,
`CHECK IN ('daily','weekly','monthly')`) is the explicit column, plus
`rent_requests.repayment_frequency_locked` (`boolean`) marking whether that
value has been deliberately confirmed/locked.

**Share of active plans with it explicitly set (locked) vs not**, counted live
today against every `rent_requests` row with `status IN ('funded','repaying')`:

| repayment_frequency | locked | count |
|---|---|---|
| daily | false | 797 |
| daily | true | 2 |
| weekly | false | 18 |
| weekly | true | 3 |

**Only 5 of 820 active plans (0.6%) are locked.** For the other 815
(99.4%), the raw column still holds a value (never actually null — the
`DEFAULT 'daily'` guarantees that), but at least one existing function
(`get_tenant_ops_repayment_watchlist()`) does **not** trust the unlocked
column alone — it additionally applies a heuristic,
`rent_request_is_weekly_shape(duration_days, registration_type)` (`duration_days`
is a positive multiple of 7, not one of 30/60/90/120, and
`registration_type <> 'outstanding_balance'`), treating a plan as weekly if
*either* the column says so *or* the heuristic says so. `rent_plan_schedule_days()`
(the actual billing engine, §1) does **not** apply this heuristic — it trusts
the raw `repayment_frequency` column alone.

Checked live whether these two rules currently disagree in the dangerous
direction (stored `daily`, heuristic says weekly — which would mean the
watchlist reports a plan as weekly while the billing engine is actually
billing it daily): **zero such rows exist today.** Three unlocked rows are
stored `weekly` while the heuristic alone would say not-weekly, but since the
watchlist's rule is an OR, the stored value already carries it — no live
disagreement in practice. This is a structural risk (two different rules,
only accidentally aligned), not a currently-manifesting bug.

---

## 4. Landlord receipt — every timestamp between funding and landlord payment

**`disbursement_records`** exists but is **dead**: 9 rows total, latest
`created_at` 2026-03-24 — six months stale versus everything else in this
system. Do not build against it.

**Live objects, in the order money actually moves:**

1. `rent_requests.funded_at` — when the plan itself was funded (CFO/finance
   side), not evidence of landlord receipt.
2. `agent_landlord_float_allocations` (`id, rent_request_id, allocated_amount,
   paid_out_amount, remaining_amount, status, source, created_at, updated_at,
   funded_by_partner_id, funding_reference`) — an allocation of committed
   float toward a specific landlord; `paid_out_amount > 0` is the weak
   "landlord evidence" signal already used as a gate in `v_rent_plan_schedule`
   and the Calling Center population view (§1, §6) — it only proves the
   *agent's own float* moved, not that the landlord received anything.
3. `landlord_payout_otp_challenges` (`id, ..., otp_hash, otp_expires_at,
   attempts, max_attempts, status, verified_at, resulting_payout_id, ...`) —
   an OTP sent to and entered by the landlord at the moment of payout.
4. `landlord_payouts` (`id, ..., otp_verified_at, disbursed_at,
   finops_disbursed_at, finops_disbursed_by, finops_momo_reference,
   receipt_number, receipt_image_url, receipt_uploaded_at, escalated_at,
   escalated_reason, ...`) — **live and active**, 1,156 rows, latest activity
   today (2026-09-26).

**Population counted live, out of 1,156 `landlord_payouts` rows:**

| Timestamp | Populated |
|---|---|
| `otp_verified_at` | 1,156 (100%) |
| `disbursed_at` | 1,031 (89%) |
| `finops_disbursed_at` | 988 (85%) |
| `receipt_uploaded_at` | 18 (1.5%) |

**Strongest evidence the landlord actually received money: `landlord_payouts.otp_verified_at`.**
It requires the landlord's own phone/OTP at the moment of payout (independent
of the agent or ops staff self-reporting), and it is the only one of these
fields populated on every single row. `disbursed_at`/`finops_disbursed_at`
are internal-staff self-reports (weaker, and 11–15% missing); `receipt_uploaded_at`
is the strongest documentary evidence when present but is rare (1.5%) and
should not be relied on as a general-purpose signal.

---

## 5. Reversals — how is a reversed collection marked?

**Both** — a column, and separately, inconsistent free text. Confirmed live
on `agent_collections`:

- `reversed_at` (`timestamptz`, nullable) — the authoritative marker.
- `notes` (`text`) — some reversal code paths *additionally* prepend a
  `[REVERSED: ...]` marker into this free-text field.

Counted live: 15,731 total rows in `agent_collections`. 1,274 have
`reversed_at IS NOT NULL`. 1,226 contain the `[REVERSED:` text marker. Every
notes-marked row also has `reversed_at` set (0 rows are notes-only), but
**48 rows have `reversed_at` set with no notes marker at all** — i.e. the
notes-text marker is an incomplete subset of the column, not an equivalent
alternative.

**Every place that filters for it** (grepped across both migration trees):
the overwhelming majority of reporting/eligibility functions (CFO reports,
agent performance, PSO reports, top-up eligibility, tenant payment message
vars — at least 15 distinct migration files) filter `reversed_at IS NULL`,
correctly and consistently. **One significant exception**: `rent_apply_collections_to_days()`
(§2, the day-settlement waterfall itself) filters
`COALESCE(ac.notes, '') NOT ILIKE '%[REVERSED:%'` instead of `reversed_at IS NULL`.
Given the 48-row gap measured above, this means **up to 48 reversed
collections could still be matched into the day-settlement waterfall as if
they were valid funds** — this is an existing defect in an existing object,
which under `docs/TOPS_RULES.md` we do not fix or work around by patching
that function; it is listed under "Sources that do not meet our standard"
below.

---

## 6. Calling engine — every `cc_*` table, its RPCs, and how a round opens

**18 tables** confirmed to exist live today: `cc_call_attempts, cc_call_cycles,
cc_concern_attachments, cc_concern_overseers, cc_concern_reviewers,
cc_cycle_populations, cc_cycle_rows, cc_feedback, cc_feedback_amendments,
cc_feedback_categories, cc_filter_buckets, cc_filter_options, cc_followups,
cc_forwarded_concern_events, cc_forwarded_concerns, cc_legacy_outcome_map,
cc_received_calls, cc_sort_options`. Column lists for every one of these were
captured from the live generated types (regenerated 2026-09-26) by a
delegated research pass; five of them (`cc_call_attempts, cc_call_cycles,
cc_cycle_rows, cc_feedback, cc_feedback_categories`) plus three enums
(`cc_subject_type: tenant|landlord|agent`, `cc_row_state:
to_call|engaged|unreachable|callback|parked|closed`, `cc_attempt_outcome:
engaged|no_answer|phone_off|wrong_number|refused|callback_booked`) have **no
`CREATE TABLE`/`CREATE TYPE` anywhere in either migration tree** — only later
`ALTER`s reference them. I confirmed directly against production that all
five tables genuinely exist with real data; only their original founding DDL
is missing from this repo's migration history (the exact drift CLAUDE.md
warns about). Full constraint/index/trigger detail on these five: **UNKNOWN**.

**RPCs**: roughly 45 `cc_*` functions exist, covering reveal/record/void/
callback (the call-attempt lifecycle), concern forwarding/reviewing/
reassignment, feedback and its amendment trail, and cycle/queue management.
Full list with reads/writes/call-sites is in the delegated research
transcript; the headline ones for round management:

- **`cc_open_cycle(p_subject_type, p_population_code, p_limit?, p_title?, p_description?)`**
  — requires role `operations`/`hr`/`super_admin`; refuses if a cycle for
  that `subject_type` is already open; inserts one `cc_call_cycles` row
  (`retry_after_days=3`, `attempt_cap=2`, both hardcoded); then dynamically
  `EXECUTE`s a roster query against **whatever view is currently named in
  `cc_cycle_populations.source_view`** for that population, `DISTINCT ON`
  subject, ordered by `priority_column DESC NULLS LAST`, filtered by the raw
  `filter_sql` text stored on that row, capped at `LEAST(p_limit, max_rows)`,
  and bulk-inserts into `cc_cycle_rows` with `state='to_call'`.
- **`cc_topup_cycle(p_subject_type)`** — additive-only re-run of the same
  roster query against the currently-open cycle, `WHERE NOT EXISTS (already
  in this cycle)`, `ON CONFLICT DO NOTHING` — never removes rows.
- **`cc_abandon_cycle(p_cycle_id, p_reason)`** — force-closes any row still
  `to_call`/`unreachable`/`callback`, sets `cc_call_cycles.closed_at`.
- **`cc_close_cycle(p_cycle_id)`** — exists live (confirmed via
  `to_regprocedure`), but **its SQL body is not present in either migration
  tree** — UNKNOWN beyond its signature.

**Current live `cc_cycle_populations` rows** (queried directly, 2026-09-26):

| subject_type | code | source_view | subject_id_column | priority_column | filter_sql | max_rows |
|---|---|---|---|---|---|---|
| tenant | tenants_active_plans | `v_cc_tenant_calling_population` | tenant_id | arrears_amount | (none) | (none) |
| landlord | landlords_all | `v_landlord_calling_base` | landlord_id | monthly_rent | (none) | 500 |
| landlord | landlords_with_houses | `v_landlord_calling_base` | landlord_id | houses_monthly_rent | `houses > 0` | (none) |
| landlord | landlords_with_plans | `v_landlord_calling_base` | landlord_id | plan_rent_total | `plans > 0` | (none) |
| agent | agents_directory | `vw_agent_ops_directory` | agent_id | (none) | `not coalesce(is_frozen,false)` | (none) |

**No cron job is tied to any `cc_*` function.** Grepped every `cron.schedule`
in both migration trees (~100 jobs) — round opening/top-up/closing is
manual-only, triggered from the Calling Hub UI. (A same-named-sounding but
unrelated system, `crm_sweep_stale_calls()` on a 10-minute cron, ages out
stale telephony sessions in the separate `crm_*` dialer subsystem — not this
one; do not conflate the two in any future doc.)

**Important, unrelated-to-this-brief but urgent discovery, confirmed live
just now**: the frontend (`src/hooks/useCallingConcerns.ts`) calls
`cc_open_concerns_directory()` and `cc_join_concern(uuid, text)` — neither
function exists in production (`to_regprocedure` returns null for both under
every signature). Additionally, `cc_can_view_concern` currently runs its
*original*, narrower body (no active-staff/open-concern branch) — the
broadened version does not exist live either. All three were applied and
verified live earlier in this session, under a *different* task, and have
since been reverted or never persisted past that session. This is a real
production regression in an already-shipped feature, **outside this
investigation's scope to fix** — flagged to the user directly, not acted on
here.

---

## 7. Restructuring — pause, renew, reopen

**`rent_repayment_pauses`** columns: `id, rent_request_id, tenant_id,
subscription_id, pause_days (CHECK IN (7,14,30)), reason, paused_by, paused_at,
resume_on, resumed_at, status (CHECK IN ('active','resumed','cancelled')),
previous_next_charge_date, previous_end_date, metadata, created_at, updated_at`.

- **PAUSE**: `pause_tenant_repayment(...)` **inserts** a new row per
  occurrence (a unique index only constrains one *active* pause per plan at a
  time, so history across separate pauses does accumulate as separate rows).
  Its *resolution* — `cancel_tenant_repayment_pause(...)` or the cron-driven
  `resume_expired_repayment_pauses()` (schedule `10 0 * * *`) — **mutates
  that same row** (`status`, `resumed_at`). So: new-row-per-occurrence, but
  in-place resolution — not a pure append-only log, not a pure mutated
  status column either.
- **RENEW**: two unrelated things share the word.
  `renew_expired_rent_request(...)` just resets a still-*pending* request's
  pending-window — not a plan renewal. The real one,
  `renew_rent_request(p_prev_request_id, ...)`, **inserts a wholly new
  `rent_requests` row** (fresh `status='pending'`, `registration_type='renewal'`)
  copying forward tenant/landlord/rent terms. **There is no linking column**
  (no `previous_request_id`/`renewed_from`/`parent_request_id`) and the
  function writes no audit/event row at all — the only way to relate a
  renewal to its predecessor is inference by `tenant_id` + `registration_type='renewal'`
  + `created_at` ordering.
- **REOPEN**: `reopen_rent_request(...)` only works on `status='rejected'`
  requests; **mutates** `rent_requests` (`status`, `reopened_at`,
  `reopened_by`, `reopen_count`, `reopen_reason`) — a 3-reopen lock applies
  unless the caller has role `manager`. It *also* inserts genuine append-only
  rows into both `audit_logs` and `system_events`.

**Caveat on both "append-only" logs, confirmed by migration inspection**:
`system_events` has a `cleanup_old_system_events()` function that `DELETE`s
rows older than 7 days — no cron job calling it was found, so whether this
runs routinely in production is **UNKNOWN**; do not treat `system_events` as
durable beyond ~7 days without confirming that separately. `audit_logs` is
insert-by-convention but not immutable — `cfo_correct_trail_entry(...)` lets
a CFO UPDATE an existing row (keeping an `edit_history` snapshot inside
`metadata`, so the mutation is itself audited, not silent).

---

## 8. Notifications to an ops user

**`notify-managers`** (edge function) — accepts `{title, body, url?, type?,
additionalRoles?}`, resolves recipients from `user_roles` (`role IN
['manager', ...additionalRoles]`, `enabled=true`), forwards to
`send-push-notification` — **push only**, no SMS, no in-app row. Confirmed
already reused unchanged, with fully custom title/body, by at least 34
different existing edge functions — **yes, we can call it unchanged with a
new message.**

**`send-push-notification`** (edge function) — accepts `{userIds?, all?,
payload: {title, body, icon?, url?, type?, notificationId?}}`, no enum/
whitelist on `type` — **reusable unchanged** for a brand-new alert kind.

**Important constraint**: the in-app `public.notifications` table has a
`BEFORE INSERT` trigger, `block_notification_inserts` →
`block_all_notification_inserts()`, whose current body **only allows 8
specific `type` values through** (`merchandise_recovery, director_requisition,
advance_arrears, budget, staff_requisition, hr_birthday, rd_alert,
lending_repayment`) plus 2 `metadata.action` values — **every other type is
silently dropped**. A new in-app notification type cannot be added without
migrating that allowlist, which `docs/TOPS_RULES.md` rule 4 forbids touching.
Push (via `notify-managers`/`send-push-notification`) is therefore the only
existing ops-notification channel we can use unchanged; genuine in-app rows
are not available to us additively.

---

## 9. Feature flags / read-only config mechanism

**`system_config`** (`key text PRIMARY KEY, value jsonb NOT NULL, updated_at`)
is a genuine generic key/value config table, already used for at least five
unrelated keys today. A proven, reusable pattern already exists for exactly
"a boolean a page can check without writing anything":
`is_agent_perf_gate_disabled()` — a `system_config` row plus a thin
`STABLE SECURITY DEFINER` wrapper function, granted to `authenticated`
(and `anon` in that one case). Direct frontend reads of one `system_config`
row also exist (`useRentAccessLimitParams.ts`), gated by a narrow per-key RLS
policy (`USING (key = '<specific key>')`) — the default policy restricts
`system_config` to executive roles, so a new read-only key for a new tab
needs its own narrow SELECT policy naming that one key.

**Not usable**: `src/contexts/FeatureFlagsContext.tsx` exists and is wired
into `App.tsx`, but `setFlag` is never called anywhere in the codebase and
nothing persists it — it is permanently fixed at hardcoded defaults, not a
real toggle. `AgentFeatureFlagsPanel.tsx` is a per-agent capability system,
unrelated to page/tab visibility. No third-party flag SDK (GrowthBook,
LaunchDarkly, etc.) exists in `package.json` or `src/`.

**Recommendation for the kill switch**: mirror the `is_agent_perf_gate_disabled()`
pattern — a `system_config` row plus a `tops_`-prefixed read-only wrapper
function, which is additive (new function, new config key) and fits rule 4
of `docs/TOPS_RULES.md` exactly.

---

## 10. Wallet and float — the read path for an agent's current float balance

`wallets` (`id, user_id, balance, locked_balance, currency,
withdrawable_balance, float_balance, advance_balance, created_at, updated_at`)
is the raw table. The **authoritative read path**, already used elsewhere in
this codebase (e.g. inside `settle_tenant_rent_from_deposit()`), is
`get_user_wallet_view(p_user_id)` — a function backed by a derived table,
`wallet_balances_projection`, returning `{withdrawable, float_balance,
advance_balance, pending_holds, total_visible, restricted_held,
pending_portfolio_hold}`. It additionally nets out capital committed to a
pending Partner Ops portfolio approval (`funder_pending_hold(p_user_id)`) from
`withdrawable`/`total_visible` so that money cannot be double-counted as
spendable. **Read `get_user_wallet_view()`, not `wallets.float_balance`
directly**, whenever a figure needs to reflect what an agent can actually use
right now.

---

## Sources that do not meet our standard

- **`v_tenant_daily_eligibility` / `v_tenant_ops_tenant_base` / `v_cc_tenant_calling_population`**
  (pre-2026-09-26): anchored "days since repayment clock started" on the
  funding date instead of `repayment_starts_on`, inflating every figure by
  the funding-to-repayment-start gap (confirmed live: average 2.2 days,
  worst case 126 days, across all 741 tenants these objects covered) and
  fabricating a nonzero "days missed" for any tenant whose repayment had not
  started yet. **This one was already fixed directly** (in a prior session
  task, not this investigation) rather than parallel-sourced, because it was
  a pure bug-fix to an anchor date with no design disagreement involved. Any
  NEW Tenant Ops Workspace object needing "days since clock started" should
  read the now-corrected `v_tenant_daily_eligibility.start_at` or
  `v_rent_plan_schedule.term_start` rather than re-deriving it.
- **`get_tenant_ops_repayment_watchlist()`'s weekly-shape heuristic** (§3):
  disagrees in principle with `rent_plan_schedule_days()`'s "trust the raw
  column" rule for unlocked plans, even though no live row currently exposes
  the disagreement. A new Tenant Ops Workspace cadence reader should build
  its own `tops_` view trusting `repayment_frequency` alone (matching the
  actual billing engine), not copy the heuristic, and should record in the
  build log that the heuristic exists as a second, disagreeing definition of
  "weekly" elsewhere in the platform.
- **`rent_apply_collections_to_days()`'s reversal filter** (§5): uses the
  incomplete `notes ILIKE '%[REVERSED:%'` text check instead of `reversed_at
  IS NULL`, measurably missing 48 reversed collections as of today. A new
  `tops_` read-model computing anything from `agent_collections` must filter
  `reversed_at IS NULL` (the correct, complete rule already used by every
  other reporting function in the codebase) and should not copy this
  function's filter.
- **`disbursement_records`** (§4): dead, 9 rows, six months stale. Do not
  read from it for anything.
- **`system_events`** (§7): possibly non-durable beyond 7 days (cleanup
  function exists; whether it runs on a schedule is unconfirmed). A new
  `tops_` object that needs a durable pause/reopen history should poll and
  copy the relevant rows into our own storage promptly, or read `audit_logs`
  instead (durable by convention, though not strictly immutable — see §7).

## Blocked without an existing change

- **Renewal linkage** (§7): there is no column anywhere linking a renewed
  `rent_requests` row back to the plan it renewed. We can infer it
  (`tenant_id` + `registration_type='renewal'` + `created_at` ordering), but
  this is a genuine inference, not a stored fact, and a tenant with multiple
  same-day renewals or a data-entry anomaly could make that inference wrong.
  Recording an explicit link would require altering `rent_requests` (rule 2)
  or adding a trigger (rule 5) — both forbidden. Listed here for a human to
  decide whether the inference is good enough for the new tab's purposes.
- **Genuine in-app notifications for a new type** (§8): `block_notification_inserts`'s
  8-value allowlist cannot be extended additively — any row we insert with a
  new `type` is silently dropped by an existing trigger on an existing
  table. Push notifications (`notify-managers`/`send-push-notification`)
  remain fully available and reusable; in-app inbox rows for a genuinely new
  notification kind are not, without a change to that allowlist.
- **`cc_close_cycle`'s exact behaviour** (§6): the function exists live and
  is called by the Calling Hub UI, but its SQL body is not present in either
  migration tree, so its exact semantics (does it force-close outstanding
  rows the same way `cc_abandon_cycle` does? does it require a reason?) could
  not be confirmed. If the new tab needs to react to a cycle closing, this
  should be confirmed with a human or by careful live testing first, not
  assumed from `cc_abandon_cycle`'s behaviour.
- **Full DDL for `cc_call_attempts`, `cc_call_cycles`, `cc_cycle_rows`,
  `cc_feedback`, `cc_feedback_categories`, and the `cc_subject_type`/
  `cc_row_state`/`cc_attempt_outcome` enums** (§6): all confirmed to exist
  live with the column lists given, but their founding DDL (constraints,
  indexes, triggers) is not recorded anywhere in this repo's migration
  history. Nothing prevents reading them additively, but anyone adding an
  index or constraint of our own that references these tables should
  double-check live behaviour first rather than assuming from the column
  list alone.
