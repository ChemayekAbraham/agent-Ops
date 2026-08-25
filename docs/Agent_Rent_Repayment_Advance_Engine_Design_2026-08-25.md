# Agent Rent Repayment → Agent Advance Engine

**Design note, 2026-08-25.** Written against the system as it exists today (live schema, live views, live crons, live data pulled 2026-08-25).

---

## 1. What the request is

When a tenant stops repaying, the money still has to reach Welile. Today that gap sits nowhere: the rent request quietly ages, `amount_repaid` stops moving, and the agent — who is already the contractual guarantor (`rent_requests.agent_guarantor_consent`, `agent_liability_triggered`) — carries no ledger consequence until somebody notices manually.

The ask: convert silent tenant inactivity into an explicit, dated, ledger-backed **agent advance**, with two tripwires:

- **Day 2 of no repayment activity → FLAG** (observation only, no money moves).
- **Day 8 of no repayment activity → ADVANCE** the amount that should have been collected into the agent's `advance_balance` as debt.

Plus two guardrails the request names explicitly:
1. Weekly-paying tenants must not be punished for being weekly.
2. There must be a **daily cap** on how much can be advanced to one agent, and the flag/advance evaluation must run **after the day's collection window closes**, using observed collection behaviour to set that closing time.

---

## 2. What the system already has (the honest inventory)

### 2.1 Expectation side — what a tenant owes per day

`rent_requests` is the contract row. Relevant fields:

| Field | Meaning today |
|---|---|
| `daily_repayment` | The per-day expectation. This is the number every capacity/eligibility surface sums. |
| `total_repayment`, `amount_repaid` | Contract total and cumulative repaid. Outstanding = `total_repayment - amount_repaid`. |
| `duration_days`, `number_of_payments` | Term length and instalment count. **`number_of_payments` is months in practice**, not payment events. |
| `status` | Only `funded` / `repaying` are live for collection. |
| `agent_payment_status` | `paying` / `not_paying`. `not_paying` deliberately removes the row from daily expectation. |
| `collection_locked_at`, `collection_lock_days` | Existing collection suppression. |
| `outstanding_grace_days` | Existing per-request grace concept — already the right hook for a per-tenant override of the 2/8-day thresholds. |
| `agent_guarantor_consent`, `agent_liability_triggered`, `agent_liability_amount` | The legal basis for charging the agent. Today `agent_liability_*` is only ever set by hand. |

`v_tenant_daily_eligibility` and `v_agent_daily_eligibility` are the two views that already decide *who is expected to pay today*. `v_agent_daily_eligibility` excludes, in this order: reversed float allocations without repayment, active rows in `rent_repayment_pauses`, fully-repaid rows, and rows whose landlord leg was never settled. **The advance engine must reuse exactly this eligibility set — not re-derive it.** Any second definition of "expected today" will drift within a week.

### 2.2 Payment side — what actually came in

`agent_collections` is the single source of collection truth (already a locked constraint in this codebase: *"Today's capacity `paid_today` reads ONLY from `agent_collections`"*). Key fields: `rent_request_id`, `agent_id`, `tenant_id`, `amount`, `payment_method`, `created_at`, `float_before` / `float_after`.

So **"repayment activity"** for this engine has exactly one definition:

> the most recent `agent_collections.created_at` for that `rent_request_id`.

Not `rent_requests.updated_at`, not `amount_repaid` deltas, not ledger legs. One column, one index.

### 2.3 Advance side — where the debt would land

`agent_advances` already models everything needed:

`principal`, `outstanding_balance`, `daily_installment`, `installment_amount`, `repayment_frequency`, `monthly_rate` / `daily_rate`, `arrears_balance`, `recovery_source`, `deduction_paused`, `status`, `request_id`, plus a full reversal block (`reversed_at`, `reversal_amount`, `reversal_clawback_group_id`).

Supporting machinery that already exists and must be respected, not bypassed:

- `agent_advance_ledger` — per-day opening/interest/deduction/closing rows.
- `sweep_agent_advance_recovery`, `tg_recover_advance_arrears_on_earning`, `apply_roi_advance_recovery` — recovery already pulls from incoming commission/earnings.
- `enforce_no_double_agent_advance`, `enforce_agent_advance_min_principal`, `enforce_advance_daily_installment`, `enforce_tiered_advance_rate`, `zz_guard_agent_advance_double_charge` — hard triggers. A new advance created by a cron **will** hit these.
- `create_overdraft_recovery_advance` — the closest existing precedent: a system-created advance, not a requested one. The new engine should follow this shape rather than the `agent_advance_requests` → 4-stage-approval shape.
- `advance_fee_config` (`default_monthly_rate`, `min_rate`, `max_rate`, `daily_recovery_rate`) — where the pricing of a guarantor advance must be configured, not hardcoded.

Wallet mechanics are already fixed by platform rule: `apply_wallet_movement` is the only writer, `advance_balance` is the liability bucket, and recovery auto-drains from incoming salary/commission. The engine posts a ledger transaction and lets the existing triggers do the rest.

### 2.4 What is genuinely missing

1. No stored notion of **last repayment activity** per rent request (it is recomputed by scan every time).
2. No **flag state** — nothing records "this tenant went quiet on the 21st".
3. No **payment cadence** per tenant, so weekly payers are indistinguishable from defaulters.
4. No **daily collection cut-off** concept — evaluation would currently race live collections.
5. No **per-agent daily advance cap**.
6. No idempotency key for "we already advanced this tenant's gap for this window".

Those six gaps are the whole build.

---

## 3. What the live data says (this is what sets the numbers)

### 3.1 When collections actually happen

`agent_collections`, last 60 days, by hour (Africa/Kampala):

```text
06h   73    |=
07h  313    |======
08h  632    |=============
09h  702    |==============   <- peak
10h  570    |===========
11h  380    |=======
12h  256    |=====
13h  355    |=======
14h  399    |========
15h  162    |===
16h  215    |====
17h  138    |==
18h  167    |===
19h  200    |====
20h  252    |=====
21h  258    |=====
22h  284    |=====
23h  179    |===
00h   30    |
```

Reading: real field collection is **07:00–15:00**, peaking 08:00–10:00. The 20:00–23:00 tail is not field work — it is back-office entry, offline sync and reconciliation catching up on the same day's cash. Only ~1.5% of events land 00:00–05:00.

**Therefore the daily collection window closes at 23:59 Kampala, and evaluation runs at 00:30 Kampala on the following day.** This is not arbitrary: 00:30 is already the slot used by `snapshot-agent-daily-eligibility`, so the engine can read a settled, snapshotted day rather than a moving one. Anything earlier than 23:59 would misclassify the evening reconciliation tail as non-payment.

### 3.2 Gaps between consecutive payments on the same rent request (90 days)

```text
0d  1394 | same-day top-ups
1d  2022 | daily payers            <- dominant
2d  1197 |
3d   704 |
4d   441 |
5d   289 |
6d   235 |
7d   156 | weekly payers
8d    83 |
9d    86 |
10d   47 |
11d   48 |
12d   34 |
13d   36 |
14d   48 | fortnightly
15d+ 278 | genuine distress
```

Reading: ~68% of intervals are ≤2 days. The curve decays smoothly to day 7, then thins hard. There is a real but small 7-day and 14-day population. **A flat 8-day rule applied to every tenant would sweep up the 7d cohort on a bad week** — that is exactly the weekly-tenant risk the request names.

### 3.3 Current exposure by silence bucket (live, funded/repaying, excluding `not_paying`)

| Bucket | Tenants | Daily expectation at risk |
|---|---|---|
| Paid within 2 days | 172 | UGX 3,218,939 |
| 2–8 days quiet | 158 | UGX 3,998,784 |
| 8–30 days quiet | 106 | UGX 1,920,125 |
| 30+ days quiet | 113 | UGX 1,407,670 |
| Never paid | 108 | UGX 1,434,276 |

Reading, and this is the single most important number in this document: **turning the rule on with no ramp would advance the 8-30d, 30d+ and never-paid cohorts at once — 327 tenants, roughly UGX 4.76m of *daily* expectation, compounding.** Charged as a lump backlog it would be tens of millions landing in agent `advance_balance` overnight. That is not a collections engine, that is a mass write-down against the field team.

The engine must therefore be **forward-only from go-live**: the first evaluation date establishes a baseline, and only silence *accruing after* that date can produce an advance. Legacy 30d+/never-paid rows route to a manual Agent Ops worklist, not to the cron.

---

## 4. The design

### 4.1 Cadence classification (solves the weekly-tenant problem)

Per rent request, from `agent_collections` history, classify cadence:

- `daily` — median inter-payment gap ≤ 2 days, or fewer than 3 payments and the contract is daily.
- `weekly` — median gap in 5–9 days, at least 3 payments.
- `fortnightly` — median gap in 12–17 days, at least 3 payments.
- `irregular` — everything else.
- `unknown` — fewer than 2 payments (falls back to the contract default: `daily`).

Cadence drives the thresholds, so the tripwires become **cadence-scaled**, not flat:

| Cadence | Flag at | Advance at | Rationale |
|---|---|---|---|
| daily | 2 days quiet | 8 days quiet | The rule as requested. |
| weekly | 9 days quiet | 16 days quiet | One full missed cycle to flag, two to charge. |
| fortnightly | 17 days quiet | 31 days quiet | Same logic, one cycle. |
| irregular / unknown | 2 days quiet | 8 days quiet | Default to the strict rule. |

`rent_requests.outstanding_grace_days` overrides the flag threshold per tenant where Ops has already granted grace.

Cadence is recomputed nightly and stored, so both the engine and every UI read the same label. It is a stored classification, not an ad-hoc recomputation per surface.

### 4.2 The two tripwires

**Day 2 (flag) — no money moves.** Insert/refresh a flag row: rent request, agent, tenant, cadence, days quiet, expected-shortfall-to-date, `state = 'flagged'`. Emit a `system_event` (platform rule: all state changes emit events). Notify the agent by SMS (sender `WELILE`) and surface it in the agent's Priority Collection queue and in Agent Ops. A flag clears itself the moment a matching `agent_collections` row arrives — clearance is data-driven, never manual.

**Day 8 (advance) — money moves.** Compute the gap, cap it, then create a system advance:

```text
gap = Σ daily_repayment over quiet days since the later of
        (last collection date, engine baseline date)
      capped at remaining outstanding (total_repayment − amount_repaid)
      capped at the agent's remaining daily advance headroom
```

The advance is created through one SECURITY DEFINER RPC — call it `create_guarantor_recovery_advance` — modelled on `create_overdraft_recovery_advance`, so it inherits the existing trigger stack rather than fighting it. It posts the ledger transaction, lets `apply_wallet_movement` move `advance_balance`, writes the `agent_advance_ledger` opening row, stamps `rent_requests.agent_liability_triggered / agent_liability_amount / agent_liability_reason`, and marks the flag `state = 'advanced'`.

Pricing comes from `advance_fee_config`. A guarantor advance is a recovery instrument, not a credit product: it should use `min_rate`, not `default_monthly_rate`, and recover through the existing commission sweep at `daily_recovery_rate`. The agent is being asked to carry a gap, not to buy financing.

### 4.3 The daily cap

Two limits, both required:

1. **Per-agent daily cap** — the maximum that can be advanced to one agent in one evaluation run. Anchored on observed capacity, i.e. the agent's `expected_daily` from `v_agent_daily_eligibility` (a natural, self-scaling ceiling: an agent handling UGX 40k/day of expectation cannot absorb UGX 400k of gap in one night). Suggested start: **1× `expected_daily`**, configurable.
2. **Platform daily cap** — a total ceiling per run, so a data incident cannot mint unbounded liability. A run that would breach it advances the highest-confidence cases and defers the rest.

Anything deferred by a cap stays flagged, keeps accruing, and is retried the next night. Nothing is silently dropped, and nothing is double-charged.

### 4.4 Idempotency

One advance per (rent request, quiet window). The natural key is `(rent_request_id, window_start_date)`, enforced by a unique index, so a cron re-run, a retry, or a manual trigger cannot double-charge. This mirrors how `email_credit_idempotency` protects the credit path.

### 4.5 Reversal

Reversal must exist from day one. If a collection is later back-dated into the quiet window, or Ops rules the tenant was genuinely paused, `reverse_agent_advance` already handles partial clawback and preserves shortfalls as active debt. The engine only needs to link its advance to the flag so a reversal can restore the flag state instead of leaving an orphan.

---

## 5. What this unlocks for data aggregation and decisions

Once flags are stored rather than recomputed, four things become answerable that are not answerable today:

1. **Time-to-silence per agent** — how long after funding an agent's tenants go quiet. This is a far sharper agent-quality signal than `paid_today / expected_daily`, which a single good morning can flatter.
2. **Cadence mix per agent and per region** — an agent whose book is 60% weekly is running a different business from one at 95% daily, and their daily targets should not be compared as if they were the same.
3. **Recovery yield** — of guarantor advances raised, how much came back through the commission sweep versus ageing into `arrears_balance`. This is the true cost of the guarantor model, and today nobody can price it.
4. **Flag→pay conversion** — the share of day-2 flags that resolve before day 8. If that rate is high, the flag alone is doing the work and the advance is a rarely-used backstop. If it is low, the flag is noise and the thresholds need moving. Either way, the number decides.

Every one of these reads off flag rows plus `agent_collections`. No new aggregation pipeline.

---

## 6. Rollout, in the order that keeps trust intact

**Phase 1 — Observe.** Ship cadence classification, last-activity tracking, flag rows, and the flag UI. Advance creation is **disabled**. Run 14 days. Record how many day-2 flags convert before day 8, and how many weekly payers get wrongly flagged. This phase is what proves the thresholds; skipping it means charging agents against numbers nobody has validated.

**Phase 2 — Dry run.** Cron computes advances and writes them to a shadow table. Agent Ops and CFO review daily totals against the caps. No wallet movement, no ledger legs. Tune caps and rates here.

**Phase 3 — Live, capped, forward-only.** Enable creation for `daily`-cadence tenants only, with the per-agent cap at 1× `expected_daily`, and a baseline date so no legacy backlog is charged. Weekly and fortnightly cadences stay observe-only.

**Phase 4 — Extend.** Bring weekly and fortnightly under the engine once Phase 3 shows a stable reversal rate (target: under 5% of advances reversed).

Legacy 30d+ and never-paid rows never enter the cron. They go to a manual Agent Ops worklist with an explicit decision — write off, restructure, or charge the agent — because each one has a story the cron cannot read.

---

## 7. The honest risks

- **Agent trust.** An advance that appears overnight, unexplained, will be read as theft. The day-2 flag SMS is not a nice-to-have; it is what makes the day-8 charge legitimate. No flag, no advance — that should be a hard precondition in code.
- **Cadence misclassification on thin history.** A tenant with two payments has no reliable cadence. Defaulting to `daily` is the strict choice; it is also the wrong one for a genuinely weekly tenant with a short history. Mitigation: require 3 payments before a non-daily label, and let Ops set cadence manually on the rent request.
- **Double liability.** `agent_landlord_float_allocations` and `agent_tenant_float_reversals` already move money against the same rent request. The engine must exclude any request with an open allocation or an existing untriggered liability, or the agent pays twice for one gap.
- **Cap gaming.** Because the per-agent cap scales with `expected_daily`, an agent could mark tenants `not_paying` to shrink expectation and thus their cap. `agent_payment_status` changes are already audited; that audit needs to feed the cap calculation, not just the UI.

---

## 8. Summary of what gets built

| Piece | Nature |
|---|---|
| Cadence + last-activity classifier | Nightly job, stored per rent request |
| Flag table + lifecycle (`flagged` → `cleared` / `advanced` / `deferred`) | New table, event-emitting |
| Evaluation cron at 00:30 Kampala | Reads settled day, reuses `v_agent_daily_eligibility` |
| `create_guarantor_recovery_advance` RPC | Modelled on `create_overdraft_recovery_advance` |
| Per-agent and platform daily caps | Config-driven, anchored on `expected_daily` |
| Idempotency index on (rent request, window start) | Prevents double-charge |
| Agent-facing flag surface + SMS | Precondition for any advance |
| Agent Ops legacy worklist | Manual path for pre-baseline backlog |

Nothing here invents new financial primitives. It connects three things the platform already has — tenant expectation (`v_tenant_daily_eligibility`), collection truth (`agent_collections`), and agent liability (`agent_advances`) — with an explicit, capped, reversible, forward-only rule between them.

---

## 9. What happens when the agent repays the guarantor advance

This is the question the design above left open. Raising the debt is the easy half; the repayment path is where the engine either stays honest or quietly corrupts two ledgers at once.

### 9.1 The debt is agent debt, not tenant debt

The moment a guarantor advance is raised, the platform holds **two separate claims on the same original gap**:

| Claim | Lives in | Owed by | Reduced by |
|---|---|---|---|
| Rent contract outstanding | `rent_requests.total_repayment − amount_repaid` | The tenant | `agent_collections` rows for that request |
| Guarantor advance outstanding | `agent_advances.outstanding_balance` | The agent | Advance recovery (`agent_advance_ledger` rows) |

They must never be netted in one step, and neither one may be silently written down by activity on the other. The advance is Welile taking the agent's promise instead of the tenant's cash; the tenant still owes the rent.

### 9.2 The three ways the advance comes back

1. **Automatic recovery from earnings (default).** No new machinery. The advance is created with `recovery_source` pointing at the existing sweep, and `sweep_agent_advance_recovery` / `tg_recover_advance_arrears_on_earning` drain it from incoming commission, bonuses and payroll exactly as any other advance. The agent never sees a bill; their next earnings arrive net.
2. **Voluntary early payment.** The existing `VoluntaryRepayAdvanceDialog` / `voluntary-repay-advance` path already works on any `agent_advances` row, so it works on a guarantor advance with no change. The agent pays N days ahead from withdrawable balance and the next N scheduled deductions are skipped.
3. **The tenant finally pays.** This is the new case and it is handled in 9.3.

Every one of the three writes an `agent_advance_ledger` row **first**, checks the error, and only then debits the wallet — the double-charge guard (`zz_guard_agent_advance_double_charge`) requires that order and will reject a stale opening balance.

### 9.3 When the tenant pays after the advance was raised (settlement offset)

The rule: **tenant money always lands on the tenant's contract first, then flows through to the agent's advance as a credit.**

Sequence for a collection on a rent request that has an outstanding guarantor advance:

```text
1. Insert agent_collections row            (collection truth, unchanged)
2. Reduce rent_requests.amount_repaid      (tenant contract, unchanged)
3. Detect: does this request have a guarantor advance with outstanding > 0?
4. If yes, offset the advance by
     min(collection_amount, advance_outstanding_attributable_to_this_request)
   via an agent_advance_ledger row of kind `guarantor_offset`
5. Post the ledger transaction; apply_wallet_movement reduces advance_balance
6. Any surplus above the attributable advance stays as ordinary
   tenant repayment and pays the agent commission as normal
```

Two consequences worth stating plainly:

- The agent is made whole in the same order the debt was raised. They are not paid commission on the offset portion — that money is repaying their own guarantor debt, not new production. Commission resumes on the surplus.
- If the tenant over-pays past both the advance and the contract, the excess follows the existing overpayment path. The offset never creates a negative advance.

### 9.4 What happens on full settlement

When a guarantor advance reaches zero it closes with an outcome recorded, not just a status:

- `settled_by_tenant` — cleared by offsets under 9.3. The agent carried timing risk only. **No trust-score penalty.**
- `settled_by_agent` — cleared by earnings sweep or voluntary payment. The agent absorbed a real default. This is the number the guarantor model actually costs, and it should feed the agent's rating and the recovery-yield metric in section 5.
- `reversed` — Ops or a back-dated collection invalidated the advance; `reverse_agent_advance` clawback applies and any shortfall stays active debt.

Without that outcome field, "recovery yield" is unmeasurable, because a tenant-settled advance and an agent-settled advance look identical once outstanding hits zero.

---

## 10. Multi-tenant attribution: which tenant is this payment for?

An agent with 20 tenants can accumulate several guarantor advances. "I can pay this amount and this amount to this tenant" has to be answerable by the system, not by the agent's memory.

### 10.1 One advance per (rent request, window) — never one blended advance per agent

The idempotency key from 4.4, `(rent_request_id, window_start_date)`, is also the attribution key. Each guarantor advance therefore carries:

- `rent_request_id` — the exact contract the gap came from
- `tenant_id` — the tenant whose silence caused it
- `window_start_date` / `window_end_date` — the quiet period charged
- `flag_id` — the day-2 flag that legitimised it

This is a deliberate rejection of the simpler design (one rolling "guarantor debt" balance per agent). A blended balance is cheaper to build and impossible to defend: the agent cannot see which tenant they are paying for, a single back-dated collection cannot be cleanly reversed, and the tenant-pays offset in 9.3 has no target.

Consequence: `enforce_no_double_agent_advance` must treat guarantor advances as scoped by `rent_request_id`, not one-per-agent, or the second tenant's advance will be blocked by the first.

### 10.2 Deterministic allocation order

The agent does not choose. Free-choice allocation is where field staff would park the oldest debt forever, and it is also unauditable. Incoming recovery money is applied by a fixed waterfall:

1. **Explicit target wins.** A tenant collection offsets that tenant's advance only (9.3). Never spills to another tenant's advance.
2. **Untargeted money (commission sweep, payroll, voluntary payment) is applied FIFO by `window_start_date`** — oldest quiet window first.
3. **Tie-break on the same date:** larger `outstanding_balance` first, so exposure falls fastest.
4. **Arrears before principal** inside each advance, matching existing advance behaviour.

The same waterfall applies whether the money arrives from a cron, a sweep or a dialog. One order, one place in code.

### 10.3 Agent-directed early payment

The agent may still say "clear Nakato's advance first" — via the pay-ahead dialog with a tenant selected, which sets an explicit target and therefore takes path 1. Directed payment is allowed; **directed avoidance is not.** The agent can pay a specific advance early, but cannot stop the FIFO waterfall from touching the oldest one when untargeted money arrives.

### 10.4 What the agent must be able to see

Attribution is only real if it is visible. The agent's advance surface needs, per row: tenant name, house, the quiet window charged, amount, how much has come back, and by which route (tenant paid vs you paid). Anything less and 10.1's ledger correctness is invisible to the person being charged, which reproduces the trust failure in section 7.

---

## 11. Advance types: a tracking taxonomy

Guarantor advances must not be indistinguishable from credit advances in `agent_advances`. They are priced differently (min rate, section 4.2), created differently (cron, no application), justified differently (a flag, not an approval chain) and reported differently (a cost of the guarantor model, not credit revenue).

A single `advance_type` discriminator on `agent_advances`, mandatory and constrained:

| `advance_type` | Origin | Priced at | Approval | Recovery |
|---|---|---|---|---|
| `credit_access` | Agent application via `agent_advance_requests` | `default_monthly_rate`, CFO-adjustable 28–33% | 4-stage, CFO approves | Daily installment + sweep |
| `guarantor_recovery` | Nightly evaluation cron (this engine) | `min_rate` | None — flag is the precondition | Sweep + tenant offset (9.3) |
| `overdraft_recovery` | `create_overdraft_recovery_advance` | Existing behaviour | None — system-raised | Sweep |
| `manual_ops` | Ops/CFO raises by hand with a reason | Set at creation | Explicit reason ≥10 chars | Sweep |

Rules that follow from having the type:

- Every filter, report, KPI and PDF that currently says "advances" must state which types it counts. The CFO advance report, the Agent Ops repayment monitor and the agent's own list all currently assume one kind of advance exists.
- The activity gate and duplicate-account blocks that apply to `credit_access` must **not** block `guarantor_recovery` — a system-raised recovery cannot be refused for failing an eligibility test.
- `min_principal` enforcement has to allow small guarantor amounts. A single missed weekly instalment can be well under the credit-product floor, and rejecting it would silently drop real exposure.
- Trust-score and rating effects differ by type: carrying a `credit_access` advance is normal business; accumulating `guarantor_recovery` advances settled as `settled_by_agent` is a quality signal about the agent's book.
- Sub-type detail (cadence at time of charge, window length) lives on the guarantor flag row, not as more enum values. Four types is the whole taxonomy; anything finer belongs in a column.

---

## 12. The collection day lock: when a payment counts as a new day

Section 3.1 set evaluation at 00:30 Kampala. That is only half the rule. The other half is deciding which calendar day a given payment belongs to, and when that day stops being editable.

### 12.1 The day boundary

**A collection belongs to the Kampala calendar day of its `agent_collections.created_at`.** Day boundary: 00:00–23:59:59 Africa/Kampala. This matches `v_agent_daily_eligibility`, which already buckets in Kampala time, and it is the only definition allowed anywhere in the engine — no UTC dates, no `date_trunc` without a timezone.

The 20:00–23:00 volume in 3.1 is back-office entry of the same day's field cash, so it correctly lands on that day. The ~1.5% arriving 00:00–05:00 is spillover entry for the previous evening and is accepted as belonging to the new day; it is too small to justify a shifted boundary, and a shifted boundary would make "today" mean two different things in two places.

### 12.2 Three distinct times, deliberately separated

| Time (Kampala) | Event | What it means |
|---|---|---|
| 23:59:59 | **Collection window closes** | Last moment a payment counts toward that day's target |
| 00:30 | **Evaluation runs** | Flags and advances computed from the closed day |
| 03:00 | **Day locks** | The day becomes immutable for target/rating purposes |

The 30-minute gap between close and evaluation absorbs clock skew and offline-sync flushes. The 2.5-hour gap between evaluation and lock is the correction window: if a collection is entered late or a payment is voided, Ops can still fix the day before it hardens.

### 12.3 What "locked" actually forbids

A locked day is **not** read-only in the raw tables — offline sync and legitimate back-dating still happen. Locking means:

- The day's collection totals, target attainment and agent daily rating are read from the snapshot (`agent_daily_eligibility_history`), never recomputed. Yesterday's rating cannot change because a payment was entered today.
- A collection inserted after lock with a `created_at` inside the locked day counts toward the **current** open day for target and rating, while remaining attributed to its true timestamp for audit and for the quiet-window reset in 12.4.
- Any locked-day change large enough to affect a flag or an advance goes to Ops as a reversal decision (`reverse_agent_advance`), not as a silent recomputation.

Without a lock, an agent's rating and every guarantor decision built on it would be permanently re-writable by late entry, and no report printed today would still be true tomorrow.

### 12.4 Effect on the quiet-window clock

Silence is measured from the **last collection timestamp**, not from the last locked day — so a back-dated payment does reset the quiet clock retroactively. That is correct: the tenant genuinely paid. The consequences are bounded:

- Back-dated payment lands **before** an advance was raised → the flag clears on the next evaluation, no money moved.
- Back-dated payment lands **after** an advance was raised, inside the charged window → the advance is reversed under 4.5 and the outcome is recorded as `reversed`, feeding the under-5% reversal target in Phase 4.

### 12.5 Same-day top-ups are not new collection days

The 1,394 zero-day intervals in 3.2 are multiple payments on one request in one day. They are **one collection day**, several collection events. The quiet clock uses the latest event; the day's attainment uses the sum. A tenant paying three times on Monday and nothing until Friday has been quiet for three days, not zero.
