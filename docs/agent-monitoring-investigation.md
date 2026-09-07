# Agent Monitoring (Tenant Ops → Classic) — investigation report

Investigation only. No UI, logic, data or navigation was changed.
Source of truth: `src/components/executive/tenant-ops/AgentMonitoring.tsx`, views
`v_tenant_daily_eligibility` / `v_rent_plan_schedule`, tables `rent_requests`,
`agent_collections`, `repayments`, `rent_repayment_pauses`.

---

## 1. What it tracks today, and how the numbers are made

One screen, one calendar day (Kampala time, day switcher + Today button).

Data pulled per load:
1. `v_tenant_daily_eligibility` → the set of rent plans considered "live and collectable".
   The view keeps only `funded` / `repaying` plans, with a tenant, and excludes plans marked
   `agent_payment_status = 'not_paying'`, plans with an active repayment pause, plans with a
   float reversal, and plans whose landlord has already been settled.
2. `rent_requests` rows with status `funded | disbursed | repaying`, then filtered down to the
   eligible ids and to rows that have an `agent_id`.
3. `agent_collections` rows created between 00:00 and 24:00 Kampala on the chosen day.
4. Every `rent_requests` row's `agent_id` (all history) to count "requests" per agent.
5. `profiles` for names, phones, created_at.

Numbers shown:
- **Tenants** = distinct `tenant_id` on the agent's eligible plans.
- **Expected** = plain sum of `daily_repayment` across those plans (one day's worth).
- **Collected** = sum of `agent_collections.amount` for that agent+tenant on that day only.
- **Rate** = collected ÷ expected, capped at 100%.
- **Requests** = lifetime count of rent requests carrying that agent id (any status).
- **Status** = Full (collected ≥ expected), Partial (collected > 0), Critical (collected = 0).
- KPI cards: number of agents in the filtered list, total expected, total collected — all
  recomputed from the filtered rows, so they follow search/status/tab filters.

Filters: free-text search (name/phone), status chips (all/full/partial/critical), day
navigation, and the tab added recently ("All agents" vs "After 1 Aug 2026", using
`profiles.created_at`). Agent row opens a dialog listing that agent's tenants
(daily amount, collected today, plan status, total/repaid), and a tenant row opens the
shared user drill-down drawer. There is no export/report from this screen.

---

## 2. Payment frequency — what the data actually supports

`rent_requests.repayment_frequency` exists and, verified on production, is `daily` for
**all 1,278** funded/repaying/completed plans. `repayment_starts_on` is populated for all of
them, `duration_days > 0` for all of them. So today the platform is effectively daily-only;
weekly/monthly plans are representable in the column but do not exist yet.

Agent Monitoring **ignores** `repayment_frequency` entirely and treats `daily_repayment`
as one day's obligation. That is correct today, and would silently overstate expectation the
day a weekly or monthly plan is created.

The canonical schedule logic already exists in `v_rent_plan_schedule`: term start =
`repayment_starts_on` (fallback funded/disbursed/created date), term end = start +
`duration_days` − 1, plus an "obligation end" that stops growing once a plan is fully repaid.
Agent Monitoring does not use it.

---

## 3. How payments and their variants are handled today

- **Payments** are recorded in two places: `agent_collections` (agent-collected, 10,779 rows)
  and `repayments` (tenant self-payments and other channels, 5,515 rows). Both carry
  `rent_request_id`; `rent_requests.amount_repaid` is the running total.
- **Agent Monitoring only reads `agent_collections`.** Tenant self-payments in `repayments`
  are invisible here, so a tenant who paid themselves makes the agent look Critical.
- **Partial payments** are recorded (`is_partial`, `expected_amount`, `shortfall_amount` on
  `agent_collections`; 638 partial rows in the last 30 days) but Agent Monitoring never reads
  those columns — it only sums `amount` and infers "partial" from the day total.
- **Advance / future coverage**: nothing. If a tenant pays 5 days at once, the day of payment
  shows 500% (capped to 100%) and the next 4 days show Critical for that agent even though
  the tenant is ahead. No notion of "already covered through date X".
- **Overpayment**: no plan in production currently has `amount_repaid > total_repayment`, and
  the screen has no handling either way.
- **Missed payments / overdue**: not computed at all. There is no arrears figure, no
  days-behind figure, and no cumulative expected-to-date. Only "did money arrive today".
- **Pauses / not-paying / ended tenancies** are excluded upstream by the view (currently 42
  live plans are `not_paying`, 0 active pauses), which is correct but invisible on screen —
  an agent's tenant simply disappears with no explanation.

---

## 4. What is missing or misleading right now

1. **Self-payments excluded** → agent performance understated. Biggest single distortion.
2. **No cumulative position.** Measured on production, only 10 of 723 live plans are at or
   ahead of a simple straight-line expectation; the screen cannot show that at all.
3. **Prepayment punished, arrears invisible.** Both come from the same missing concept:
   coverage-through-date.
4. **1,188 `agent_collections` rows have no `rent_request_id`.** Any future
   plan-level attribution must tolerate that; the current agent+tenant key hides the problem.
5. **Collected is keyed on `agent_id + tenant_id`** for the day, so a payment collected by a
   different agent for the same tenant is credited to whoever the plan is assigned to only if
   ids match — cross-agent / sub-agent collections can land nowhere.
6. **"Requests" column counts lifetime requests of any status**, including rejected and
   deleted ones — it looks like a workload metric but is not.
7. **Rate capped at 100%** hides over-collection.
8. **Expected ignores whether the plan's term has started or ended** on the viewed day. For a
   past date the screen uses today's eligible set, so historical days are re-scored against
   today's population — historical accuracy is not reliable.
9. **`disbursed` is in the status filter but not in the eligibility view**, so it has no
   effect; a harmless inconsistency that makes the code misleading.
10. **`amount_repaid` vs ledger drift** is already known (`v_rent_repaid_reconciliation`);
    any figure derived from `amount_repaid` inherits it.

---

## 5. How reporting periods should respect payment frequency

The clean rule, expressible with existing data:

- A plan has a **term window** (`repayment_starts_on` … start + `duration_days` − 1) and an
  **instalment size** and **instalment length** derived from `repayment_frequency`
  (daily = 1 day, weekly = 7, monthly = 30/calendar month if ever introduced).
- **Expected for any reporting window** = instalment size × number of that plan's instalment
  due-dates that fall inside the window ∩ term window. For daily plans this collapses to
  `daily_repayment × number of days in window`, which is what everyone expects.
- **Never** multiply `daily_repayment` by window length for a non-daily plan, and never count
  days outside the term window (before start, after end, or during a pause).
- Weekly/monthly reporting should therefore be "sum of instalments due in the period", not
  "daily × 7". Today the two agree, because every plan is daily.

---

## 6. Expected position as of any date vs actual

Per plan, at date D (Kampala date):

```
elapsed_instalments = instalments due from term_start .. min(D, term_end)
expected_to_date    = instalment_amount * elapsed_instalments   (capped at total_repayment)
paid_to_date        = sum of agent_collections + repayments for the plan up to end of D
arrears             = max(0, expected_to_date - paid_to_date)
credit_ahead        = max(0, paid_to_date - expected_to_date)
covered_through     = term_start + floor(paid_to_date / instalment_amount) - 1 instalment
days_behind         = arrears / instalment_amount   (in instalments, not calendar days)
outstanding         = max(0, total_repayment - paid_to_date)
```

Status then becomes honest and prepayment-safe:
- **Ahead** — `covered_through > D`
- **On track** — `covered_through == D` (or arrears = 0)
- **Behind** — arrears > 0, banded (1, 2–3, 4–7, 8+ instalments)
- **Settled** — outstanding = 0
- **Excluded** — not_paying / paused / tenancy ended (shown with reason, not silently dropped)

"Collected today" stays as it is — it answers a different question (field activity) and both
figures should be visible side by side rather than one replacing the other.

---

## 7. Edge cases not currently considered

- Plan whose term starts in the future (0 today, but possible) → expected must be 0, not one
  daily amount.
- Plan already fully repaid but still `repaying` → expected should stop at term/obligation end.
- Payment recorded on a date after the term end (late catch-up) → must reduce arrears, not be
  discarded.
- Same tenant with two live plans → per-plan maths, then aggregate; tenant-level counts will
  differ from plan-level counts and must be labelled.
- Collection recorded by a sub-agent or a different agent than the plan owner.
- Collection rows with no `rent_request_id` (1,188 today) → cannot be attributed to a plan.
- Reversals (`agent_tenant_float_reversals`) and refunded/duplicate collections.
- Pause that starts mid-period → expected should skip paused instalments; the pause table has
  the dates but no per-day expansion.
- Tenancy ended mid-period / plan moved to another agent mid-period → historical attribution
  is not stored per day, so past days cannot be reconstructed exactly.
- Timezone: everything must be Kampala-date based; mixing UTC dates shifts a full day.
- Agent with collections but no eligible plans (already partly handled — they appear with
  expected 0 and rate "—").

---

## 8. Data / model limitations (do not invent around these)

- **No per-instalment schedule table.** There is no row per due date, so "which instalments
  were due/paid" must be computed, and pauses can only be applied approximately.
- **No historical agent↔plan assignment.** `rent_requests.agent_id` is current-state only, so
  past-day agent league tables are approximations.
- **No snapshot of daily expectation.** Yesterday's expected cannot be reproduced exactly
  after a plan changes (there is an agent-side snapshot, `agent_daily_eligibility_history`,
  but not a tenant/plan-level one).
- **`amount_repaid` is a cache** with known reconciliation drift; sums of payment rows are
  more trustworthy but need de-duplication (the reconciliation view already documents this).
- **`repayment_frequency` is uniformly `daily`**, so any weekly/monthly behaviour is
  untested; build the general rule but do not claim it is verified.
- Nothing in the model expresses "expected payer" (tenant vs agent-collected), so an agent
  cannot be fairly excused for a self-paying tenant without a business rule decision.

---

## 9. Simplest reliable approach (recommendation)

Do the maths **once, in the database**, as a read-only view, and let the UI read it. This
avoids duplicating rules across screens and keeps the client light.

- One new view, e.g. `v_tenant_payment_position`, one row per live plan:
  plan id, tenant, agent, frequency, instalment amount, term start/end, expected_to_date,
  paid_to_date (agent_collections + repayments, de-duplicated), arrears, credit_ahead,
  covered_through, outstanding, position band, exclusion reason.
- Payments summed from the payment tables (not `amount_repaid`), with `repayments` included.
- A second, period-parameterised RPC for reports: `(date_from, date_to)` → per-agent expected
  in period, collected in period, arrears at period end, tenants ahead/on-track/behind.
- The UI keeps its current day view and adds the position columns; nothing is recalculated in
  the browser except filtering and totals.

KPIs worth having (all derivable from the above): tenants on track / ahead / behind, total
arrears, arrears-weighted agent ranking, collection rate for the period, prepaid coverage,
number of excluded plans with reasons.

Filtering/sieving: keep the existing search + status chips, and add (a) period selector
(Today / This week / This month / Custom), (b) position band filter, (c) frequency filter
(future-proofing), (d) "include self-payments" toggle so the old agent-only view remains
available. Server-side where the row count justifies it; the current volumes (≈723 live
plans, ≈650 eligible) are small enough for client-side filtering of a single fetched set.

---

## 10. UI/UX additions, preserving the current design

- Keep the header, day switcher, three KPI cards, table and dialog exactly as they are.
- Add a period selector next to the day switcher (Today stays the default).
- Add columns to the existing table: **Expected to date**, **Paid to date**, **Arrears**,
  **Ahead**, and change Status to the five honest bands — keeping the same badge component
  and colour language (Full/Partial/Critical → Settled/On track/Ahead/Behind/Excluded).
- In the agent dialog, per tenant: covered-through date, arrears, instalments behind, and a
  reason chip when the plan is excluded.
- One export button (CSV) on the table, reusing the report/archive pattern used elsewhere.
- Uncap the rate display above 100% or show "over-collected" instead.
- No navigation, permission, or styling changes.

---

## 11. Existing data vs needs clarification

**Can be built now with existing data:** expected-to-date, paid-to-date (incl. self-payments),
arrears, credit ahead, covered-through, outstanding, position bands, period expected/collected,
per-agent aggregates, exclusion reasons, CSV export, all filters above.

**Needs a business decision (not data):**
- Should tenant self-payments count towards the agent's collection rate? (Recommend: shown
  separately, included in the tenant's position, excluded from agent field-activity rate.)
- Should prepayment credit be allowed to satisfy later days for the agent's daily target?
- Grace period before a missed instalment becomes arrears (0 days? 1 day?).
- How pauses affect expected (skip instalments vs extend term).
- Whether "Requests" should be restricted to live/approved statuses.

**Needs additional data (out of scope until agreed):**
- Per-instalment schedule rows (for exact pause handling and non-daily plans).
- Historical agent↔plan assignment / daily tenant-level snapshots (for accurate past days).
- Back-filling `rent_request_id` on the 1,188 orphan collection rows.

---

## 12. Implementation-ready next step

> Scope: RentFlow only. Read-only additions; do not change existing Agent Monitoring
> behaviour, styling, navigation or any other screen.
>
> 1. Create read-only view `public.v_tenant_payment_position` (one row per plan with status
>    `funded`/`repaying`, reusing the exclusion rules of `v_tenant_daily_eligibility` but
>    reporting excluded plans with a reason instead of dropping them). Compute frequency-aware
>    instalment size/length from `repayment_frequency`, term window from `repayment_starts_on`
>    and `duration_days`, `paid_to_date` from de-duplicated `agent_collections` + `repayments`,
>    then `expected_to_date`, `arrears`, `credit_ahead`, `covered_through`, `outstanding`,
>    `position_band`. Grant `select` to `authenticated`; no writes, no triggers.
> 2. Create RPC `get_agent_payment_position(p_date_from date, p_date_to date)` returning
>    per-agent period expected, period collected (split agent-collected vs self-paid),
>    arrears at period end, and tenant counts per position band. `security definer`,
>    `set search_path = public`, restricted to ops/executive roles via the existing role helper.
> 3. Extend `AgentMonitoring.tsx` only: add a period selector, position columns, position-band
>    filter, self-payment toggle, CSV export, and per-tenant position rows in the existing
>    dialog. Reuse existing components and tokens; keep the current tabs and day view intact.
> 4. Confirm the five business questions in §11 before wiring grace periods or agent-credit
>    rules; until answered, use grace = 0 and show self-payments separately.
> 5. Verify with `npx tsgo --noEmit`, `npm run guard:all`, and spot-check three plans by hand
>    against the view output before exposing the new columns.

---

# Addendum — payment-aware reporting layer (2026-09-07)

## A. The "+2 agent boost" — verified, and it is not what the brief assumes

Searched the whole codebase and every `public` function body. There is **no rule anywhere that
boosts an agent by 2 when a tenant repays**, and nothing of the kind exists in Agent Monitoring.

What does exist, and is the only "2×" in the system:

- `src/components/CreditAccessCard.tsx` labels the agent's advance-limit component
  "Pay tenant rent (2× boost) — every UGX you allocate adds 2× to your limit".
- The live database function `public.recalculate_credit_limit(uuid)` actually computes that
  component as `LEAST(SUM(agent_collections.amount) * 0.06, 2,400,000)` — **6% of lifetime
  collections, capped at UGX 2.4M**, not 2×. The `2×` copy is stale UI text.
- The other `2×` is the Welile Vouch multiplier on angel shares (`computeVouchBreakdown.ts`),
  unrelated to agent monitoring.

So: repayments do feed an agent multiplier, but it lives in the **credit-limit engine**, keyed on
`agent_collections`, and is untouched by any monitoring/reporting change. The new reporting layer
must therefore **not** re-implement or re-weight it — it only reads. If a genuine "+2" rule is
intended, it does not exist yet and needs to be specified; I will not invent it.

## B. Source of truth (verified against the live database)

| Concept | Source of truth |
| --- | --- |
| Frequency | `rent_requests.repayment_frequency` — live data: **daily for all 1,278** funded/repaying/disbursed/completed plans; `repayment_starts_on` populated on all 1,278 |
| Term window | `v_rent_plan_schedule` (`term_start`, `term_end`, `obligation_end`, `daily_amount`, `total_amount`, `is_live`) |
| Per-day expected | `rent_plan_schedule_days(day, day)` — already used by TPPO freezing |
| Frozen historical expected | `agent_expected_day_plans` (pinned once per day by `pin_agent_expected_day`) |
| Agent-collected payments | `agent_collections` (`amount`, `is_partial`, `expected_amount`, `shortfall_amount`, `rent_request_id`) |
| Tenant self-payments | `repayments` |
| Running total | `rent_requests.amount_repaid` (carries known drift, see `v_rent_repaid_reconciliation`) |
| Collectability | `v_tenant_daily_eligibility` (excludes not-paying, paused, reversed, landlord-settled) |
| Agent multiplier | `recalculate_credit_limit` — read-only for us |
| Overpayment | none exist today (0 plans with `amount_repaid > total_repayment`) |

## C. The position model (what makes "expected by date" correct)

For a plan and an as-of date `D`:

```
instalment_days   = 1 (daily) | 7 (weekly) | 30 (monthly)      -- from repayment_frequency
due_dates(D)      = term_start, term_start+instalment_days, ...  up to min(D, obligation_end)
expected_to_date  = min(instalment × count(due_dates), total_repayment)
paid_to_date      = agent_collections + repayments, de-duplicated (same rent_request_id,
                    same amount, within 5 minutes → counted once)
arrears           = max(expected_to_date − paid_to_date, 0)
credit_ahead      = max(paid_to_date − expected_to_date, 0)
covered_through   = last due date whose cumulative expectation ≤ paid_to_date
outstanding       = max(total_repayment − paid_to_date, 0)
```

Position band: `Ahead` (credit_ahead ≥ one instalment) · `On track` (arrears = 0) ·
`Behind` (arrears < one instalment) · `Overdue` (arrears ≥ one instalment) ·
`Cleared` (outstanding = 0) · `Not due yet` (D < term_start).

This directly satisfies the brief: a weekly Thursday plan is only *due* on Thursdays, and a
5,000/day tenant who pays 20,000 shows `covered_through = D+3` and is **not** missed on those days.

Period reporting: expected for a window = instalment × count of that plan's due dates inside
`window ∩ term window`. Daily plans collapse to `daily_repayment × days`, matching today's
numbers exactly, so nothing visible changes for the current all-daily book.

## D. Recommended implementation (smallest safe surface)

1. **One new read-only view** `v_tenant_payment_position` (plan-grain, as-of today) built from
   `v_rent_plan_schedule` + `repayment_frequency` + de-duplicated payments. No writes.
2. **One new SECURITY DEFINER RPC** `get_agent_monitoring_positions(p_from, p_to, p_granularity,
   p_include_self_payments)` returning per-agent and per-tenant rows: expected-in-window,
   paid-in-window, expected-to-date, paid-to-date, arrears, credit ahead, covered-through,
   outstanding, position band. Authorisation copied verbatim from the existing ops gate.
3. **Frontend**: keep `AgentMonitoring.tsx` and its day view untouched as the default; add a
   period selector (Day / Week / Month / Custom), position columns, a position-band filter, a
   self-payments toggle and CSV export, in the existing card/tab/chip language.

## E. Risks and assumptions

- Frequency handling is **unverifiable in production** — every live plan is daily. The weekly and
  monthly branches are written from `repayment_frequency` semantics and cannot be data-tested yet.
- `1,188 agent_collections` rows have no `rent_request_id`; they can be attributed to an agent but
  not to a plan, so plan-grain paid figures will under-count those. Must be surfaced, not hidden.
- `amount_repaid` drift is inherited by anything derived from it — the model uses summed payments,
  not `amount_repaid`, and treats the difference as a reconciliation note.
- Historical days: only `agent_expected_day_plans` is truthful for the past; live re-derivation of
  a past date re-scores it against today's population.
- Open questions that block exact semantics: do self-payments count toward agent performance; does
  prepaid credit satisfy a future day's target; is there a grace period before arrears; how do
  pauses affect accrued expectation.

---

# Implementation + verification log (2026-09-07)

Shipped: read-only RPC `public.get_agent_monitoring_positions(p_from, p_to, p_include_self_payments)`
(SECURITY DEFINER, `search_path = public`, EXECUTE limited to `authenticated` and gated on
ops/executive roles in `user_roles`), plus a new "Expected vs paid" tab
(`src/components/executive/tenant-ops/AgentPaymentPosition.tsx`) inside the existing
`AgentMonitoring` tab strip. The two existing tabs and the day view are byte-for-byte unchanged.

Due dates come from the existing engine `rent_plan_schedule_days` (frequency-aware: daily = every
day, weekly = every 7th day from `term_start`, monthly = calendar month), never from multiplying a
daily figure. For days before today, `agent_expected_day_plans` (frozen) overrides the live
schedule. Payments are read from `agent_collections` + `repayments`, de-duplicated on
(plan, amount, within 5 minutes).

Verified against live production records:

| Case | Result |
| --- | --- |
| Totals for today | 1,232 plan rows, expected UGX 4,029,184 — identical to a hand-written control query |
| Advance payment covering future dates | plan `f4a0b20d…`: 9,200/day, paid 209,200, expected-to-date 128,800, credit ahead 80,400 (8.7 instalments), `covered_through` 2026-09-15 → future days are **not** reported as missed |
| Partial payment | plan `d815c401…`: expected 45,000 today, paid 2,000 → arrears 1,197,000, band `overdue` |
| Arrears | plan `3ea3210d…`: expected-to-date 5,340,000, paid 828,000, arrears 4,512,000 (exact difference) |
| Nothing due on the selected date | as-of 2026-01-01: 1,219 plans return expected 0, band `not_due_yet` |
| Period aggregation | 7-day window expected 27,814,127 = sum of the same seven single days, exactly |
| Historical date on frozen expectations | 2026-08-20: RPC 6,264,687 = frozen 6,264,687 = live schedule 6,264,687 across 219 plans |
| Unattributed agent cash | returned as separate rows (`position_band = 'unattributed'`) and shown as a footnote, never guessed onto a tenant |

**Limitation that stands.** Weekly/monthly expectation could not be verified against real records:
every one of the 1,232 live plans is `repayment_frequency = 'daily'`. The weekly/monthly branches are
the existing, already-in-use `rent_plan_schedule_days` branches (reused, not re-implemented), so a
weekly plan starting on a Thursday is due only on Thursdays — but no such plan exists yet to prove it
end to end.

Plans excluded upstream by `v_rent_plan_schedule` (marked not-paying, actively paused, ended tenancy)
still do not appear, exactly as before. Cleared / not-collectable-today plans do appear, with a
reason. No "+2 repayment boost" was created — it does not exist (see Addendum A).
