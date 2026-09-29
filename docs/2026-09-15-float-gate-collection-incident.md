# The float-gate collection incident — 15–16 September 2026

**Incident window:** 2026-09-15 15:12:23 UTC → 2026-09-16 06:03:51 UTC (guard partially fixed) → 2026-09-16 15:16 UTC (float consumption restored)
**Detected:** 2026-09-16, by the product owner noticing Agent Operations reporting ~100M collected against a ~6M bill
**Phantom collections:** 1,210 rows, **UGX 92,656,683**
**Commission overpaid:** **UGX 9,265,668.30** — recovered 2,285,902.18, written off 6,979,766.12
**Tenants wrongly still shown as owing:** 137 plans, **UGX 8,463,764** — credited back
**Status:** the defect is closed and instrumented. Two pre-existing problems it exposed are open — see §11.

This is the **third** incident of this exact shape in seven days. See
[`2026-09-10-inverted-collection-incident.md`](./2026-09-10-inverted-collection-incident.md)
and the note in `.github/workflows/deploy-edge-function.yml` about `approve-deposit`.

---

## 1. What the collection model is supposed to do

The product owner's specification, restated and then verified against a real
2026-09-14 collection of UGX 39,000:

> John Doe has a tenant who pays 2,600 daily. John's operational float is 20,000.
> The system deducts `{AgentOperationalFloat} − {TenantRepaidAmount}` → 20,000 − 2,600.
> The agent's float reduces because the operation succeeded and the collection
> completed. Commission is disbursed **once**, not indefinitely. The books balance.

That is correct, and it is how the system worked until the cutoff. The economics
are worth stating explicitly, because they are what makes the float debit
essential rather than cosmetic:

1. The agent **pre-funds float** by depositing real money (`deposit_requests` →
   `agent_float_deposit`).
2. The agent collects rent from the tenant **in cash, and keeps that cash**.
3. The platform consumes the agent's float to settle the tenant's receivable.
4. Commission — 10% to a standalone agent; for a sub-agent, 8% to them and 2%
   to their parent — is paid on the collection.

**The float debit is the payment.** It is not a permission check. If float is
not consumed, the agent has been handed the tenant's cash *and* kept their float
*and* been paid commission, and the tenant's debt has been settled out of
nothing. The correct ledger shape is four legs:

| Leg | Direction | Scope | Effect |
| --- | --- | --- | --- |
| `agent_float_used_for_rent` | `cash_out` | wallet / float | agent float falls |
| `tenant_repayment_collected` | `cash_in` | platform | settles the plan |
| `agent_commission_earned` | `cash_in` | wallet | 10% (or 8% + 2%) |
| `agent_commission_payable` | `cash_out` | platform | contra |

---

## 2. What happened

At **2026-09-15 15:12:23 UTC**, `agent_allocate_tenant_payment_internal` was
redesigned **directly in production** — drizzle migration `0114`, committed to
the repository 51 minutes *after* it was already live. The redesign made agent
float a **non-consuming eligibility gate**: the `agent_float_used_for_rent` leg
was dropped entirely and `float_before = float_after` was written into every
receipt. A new `cash_receipt_in_transit` (A5) custody leg was introduced in its
place.

That one change knocked out **three independent controls at once**.

### Control 1 — the repayment guard stopped recognising the write

`guard_rent_request_agent_updates` is a `BEFORE UPDATE` trigger that trusts a
change to `rent_requests.amount_repaid` only when it can see a matching
allocation shape — and the shape it looked for was the float leg. With the leg
gone, the guard did not recognise the write.

**And it does not raise. It silently rewrites `NEW.amount_repaid` back to the
old value.** So the UPDATE "succeeded", the RPC returned success, the ledger
legs stayed, the commission was paid — and the tenant's balance never moved.

> This is the same failure mode flagged on 10 September: *"A guard that is
> edited to match a bug stops being a guard."* Here it was worse — the guard was
> not edited, it was simply bypassed, and its failure mode is silent by design.

### Control 2 — `AMOUNT_EXCEEDS_OUTSTANDING` could not fire

Because `amount_repaid` never moved, outstanding never fell. The check that
stops an agent collecting more than a tenant owes had nothing to detect, and the
agent's own screen never showed progress — so agents reasonably re-tapped.

### Control 3 — `INSUFFICIENT_FLOAT` could not fire

Float was never consumed, so it never ran out. There was no ceiling at all.
`client_ref` — the idempotency key that would have de-duplicated re-taps — was
still not being sent by the collect dialog.

**Net effect:** an unbounded loop. Every tap was a real `agent_collections` row
paying real commission against a tenant balance that never changed.

### The worst single case

One plan (`ba5f0105`) took **169 collections totalling UGX 32.5M** while its
`amount_repaid` moved by almost nothing.

---

## 3. Timeline

| Time (UTC) | Event |
| --- | --- |
| 2026-09-15 15:12:23 | drizzle `0114` applied directly to production. Float stops being consumed. |
| 2026-09-15 16:03 | `0114` committed to the repository — 51 minutes after going live |
| 2026-09-15 → 09-16 | 1,210 duplicate collections accumulate; 27 affected agents complete 74 withdrawals totalling UGX 46,268,914 |
| 2026-09-16 06:03:51 | Josh Wanda's guard fix teaches the guard to trust the new `tenant_repayment_collected` shape. Tenant balances start moving again — the silent-drop window closes here. |
| 2026-09-16 ~13:00 | Product owner reports Agent Operations showing ~100M collected against a ~6M bill |
| 2026-09-16 15:16 | `20260916120000` — float consumption restored, verify-and-raise added |
| 2026-09-16 15:48 | `20260916180000` — duplicates reversed, commission clawed back |
| 2026-09-16 16:10 | `20260916190000` — money-path drift detector live, running every 10 minutes |
| 2026-09-16 16:23 | `20260916200000` — 137 tenant plans credited |
| 2026-09-16 16:49 | `20260916220000` — ledger contra'd, books balanced |
| 2026-09-16 16:55 → 17:32 | Reporting sweep: 72 DB functions, 52 frontend sites, 3 edge functions |
| 2026-09-16 18:03 → 18:42 | Display fixes: Kampala day boundary, capped coverage, expected on the pinned bill |

---

## 4. Damage measured

All figures deduped on `agent + tenant + plan + amount`.

| | |
| --- | ---: |
| Duplicate collection rows | **1,210** |
| Phantom "collections" | **UGX 92,656,683** |
| Commission paid on them | **UGX 9,265,668.30** |
| — still in agent wallets (recovered) | UGX 2,285,902.18 (25%) |
| — already withdrawn (written off) | UGX 6,979,766.12 (75%) |
| Tenant plans whose repayment was silently dropped | **137 plans, UGX 8,463,764** |
| Affected agents (commission) | 31 paid, 20 with a recoverable balance |

**On 2026-09-16 alone:** 1,616 collections against 249 plans, UGX 136,621,549
recorded, of which UGX 97,489,004 was duplicate.

### Why the duplicate rule is a 2-minute window, not a day

A duplicate is a repeat of the same `agent + tenant + plan + amount` **within
two minutes** — the same window Josh Wanda's duplicate guard uses.

A day-level rule would have caught 1,327 rows and UGX 105,425,606. The extra
**117 rows (UGX 12,768,923)** are same-day repeats more than two minutes apart,
and a tenant paying the same amount twice in one day is ordinary business. Those
cannot be *proven* duplicates, so they are treated as genuine: no commission is
clawed back on them, and the tenant **is** credited for them.

**The platform absorbs the uncertainty rather than either party.** This is a
deliberate accuracy trade — see §11 item 3.

### Tenants were not double-charged

> **Correction (2026-09-29, docs/HANDOVER/161):** true only before the 06:03 guard fix. Re-taps after it
> did raise `amount_repaid`; 31 plans / UGX 7,447,034 were left holding reversed duplicates and have
> now been corrected.

Worth stating plainly, because it is the one piece of good luck in this: the
same guard failure that caused the loop also kept the duplicates **out of**
`rent_requests.amount_repaid`. Zero plans are credited beyond their own total.
The duplicate reversal touches **no tenant balance at all** — only the receipt
book and the agents' commission.

---

## 5. The fix — Phase 1: stop the bleeding

**`20260916120000_restore_float_consumption_on_collection.sql`**

### a. Float is consumed again

The `agent_float_used_for_rent` `cash_out` leg is restored, exactly as verified
against a real 2026-09-14 collection. The A5 `cash_receipt_in_transit` leg that
`0114` introduced is **dropped**: under this model the platform already received
the money when the agent topped up float, so booking custody again at collection
time counts the same cash twice.

### b. Verify-and-raise — the new control

This is the layer that did not exist before, and it is the one that makes the
failure mode impossible rather than merely unlikely.

Because the guard **rewrites** rather than raises, the only way a caller can
know its write was rejected is to read the row back and compare:

```sql
RETURNING COALESCE(amount_repaid, 0), status INTO v_applied_repaid, v_new_status;
IF v_applied_repaid IS DISTINCT FROM v_amount_repaid + p_amount THEN
  RAISE EXCEPTION 'Rent collection refused: the repayment was not applied (expected %, got %). No money was moved.',
    v_amount_repaid + p_amount, v_applied_repaid USING ERRCODE = '55000';
END IF;
```

If the repayment did not land, the whole transaction — collection, commission
and all — rolls back. **Commission can never again be paid for a repayment that
did not happen.** A `SELECT … FOR UPDATE` on the plan row was added so the read-
back is not racing a concurrent collection.

### c. Duplicate guard + `client_ref`

Josh Wanda's 2-minute duplicate guard was ported into the restored function, and
`client_ref` was wired back into the collect dialog (Josh's version was kept over
mine — it covers both callers).

### d. Unfrozen

`20260916100000` had frozen `agent_allocate_tenant_payment` as an emergency stop.
The wrapper was restored once the fix was verified.

### e. The competing migration

`20260916130000` (Josh Wanda) attempted a parallel fix of the same function. It
was neutralised to a **documented no-op** — zero `CREATE OR REPLACE FUNCTION`
statements — rather than deleted, so the record of the attempt survives. Two
migrations racing to redefine the same money-path RPC is how drift starts.

**Three independent layers now guard this path:** float is consumed (so it runs
out), the repayment is verified (so a silent drop raises), and duplicates are
rejected within two minutes (so a re-tap is refused).

---

## 6. The fix — Phase 2: remediate the damage

Four migrations, in dependency order. **The product owner's instruction was:
take back what is still in the wallets, count the rest as a loss, and put nobody
into negative balance.** That instruction shaped every decision below.

### `20260916180000` — reverse the duplicates, claw back what remains

Each agent's clawback is **capped at their own withdrawable balance**; the
remainder is written off. No advance, no fee, no debt is created against any
agent. `create_overdraft_recovery_advance` would have attached a 33% platform
fee — a penalty product for an agent who overdrew, and this was not their doing.

Ledger shape mirrors how the 10 September inversion was unwound — a balanced
pair of `system_balance_correction` legs, classification `admin_correction`,
carrying `solvency_bypass_reason = 'duplicate_reversal'` (the code the enum
already had for exactly this).

Float is deliberately untouched: the duplicates never consumed any.

**Result: 20 agents, UGX 2,285,902.18 recovered, none left negative.**

### `20260916200000` — credit the tenants

**This is the only part of the incident that hurt a customer.** The duplicate
collections cost the company; this cost tenants, who could be chased for rent
they had already handed over. It was fixed first among the remediation work for
that reason.

875 collections landed inside the silent-drop window. The credit is bounded
three ways: scoped to plans collected against inside the window; genuine
collections only (2-minute re-taps excluded); and **capped at `total_repayment`**
so no plan can be credited past what it owes.

It touches **no ledger**. `create_ledger_transaction` ran *before* the UPDATE, so
the legs posted and survived — only the operational field on `rent_requests` was
rewritten. Posting anything here would count the same money twice.

Checked before writing: none of these plans carried an ops balance edit, an
unallocation or a CFO decision since 2026-09-15, so no deliberate reduction was
undone.

> **Figure to reconcile.** The migration's pre-flight estimate was 144 plans /
> UGX 8,276,097. The applied run credited **137 plans / UGX 8,463,764**. The
> genuine set moved between estimate and apply. Fewer plans for more money is
> explicable (the cap binding differently on a shifted set) but it has **not**
> been reconciled line by line, and it should be.

### `20260916220000` — balance the books

Marking rows `reversed_at` fixes the *reports*. It does not fix the *books*. The
1,210 duplicates posted real `general_ledger` rows which cannot be deleted
(`trg_prevent_ledger_delete` blocks it, deliberately). Until contra'd, the
financial statements carried UGX 92,656,683 of custody never received and the
same amount of tenant receivable never settled.

It is **one aggregate pair, not 1,210**, because collection legs key on
`source_id = rent_request_id`, not the collection's own id — a known wart. A
plan collected 169 times has 169 indistinguishable sets of legs. The honest
correction is a single balanced pair carrying the total, with the derivation
recorded in the migration so anyone can re-derive it.

Classification is `production`, **not** `admin_correction`, on purpose:
`get_treasury_cash_position` and the SOFP resolver count only
`classification IN ('production','legacy_real')`, so an `admin_correction` contra
would sit in the table looking correct and change no reported figure.

Verified on a rolled-back transaction against live production:

| | Before | After |
| --- | ---: | ---: |
| A5 custody | 888,024,817 | 795,368,134 (−92,656,683) |
| A3 receivable | −137,573,554 | −44,916,871 (+92,656,683) |

### `20260916190000` — the drift detector

`assert_money_path_intact()` reads the **live** source of the money-path
functions from `pg_proc` and checks 11 invariants, each one something that cost
real money when it broke: the float debit leg, `recipient_type =
'operational_wallet'` (which the guard matches on), the post-update assertion,
the 10%/8% commission split, and **the absence of the A5 custody leg** — its
presence means `0114` was re-applied.

It checks production's own catalogue, not this repository, **because the
repository was never the thing that drifted.** Failures are written to
`money_path_drift_events` (RLS-protected). Scheduled on pg_cron every 10 minutes.

> 20260910100000 said it and was right: *"THIS IS A BACKSTOP, NOT A SOLUTION.
> The real fix is that money-path RPCs and their guards must not be deployed
> outside a reviewed migration."* **A rule nothing enforces is a wish.** This
> enforces it by watching.

---

## 7. The fix — Phase 3: the reporting sweep

Once 1,210 rows carry `reversed_at`, every surface that does not exclude them
keeps reporting phantom money. Full inventory:
[`reversed-collections-surface-audit.md`](./reversed-collections-surface-audit.md).

**The rule is not mechanical.** Three distinctions had to be made by hand on
every single function:

- **AMOUNT reads must be filtered** — what was collected.
- **IDENTITY reads must NOT be** — or agent and tenant counts move underneath
  every other figure. `agent_ops_collection_agents` needed *both*: the universe
  unfiltered so counts hold, the activity signal filtered so an agent whose only
  recent collection was reversed stops reading as active.
- **WRITE targets must never be touched.**

> "A blind rewrite across 70+ money-path functions is the same class of change
> that inverted the collection ledger on 2026-09-10."

Delivered across `20260916210000`, `230000`, `240000` plus the earlier batch:

| Surface | Count |
| --- | ---: |
| Database functions filtered | **72** |
| Frontend read sites | **52** |
| Edge functions | **3** |
| Money readers left unfiltered | **0** |

The three edge functions — `agent-daily-performance-report`,
`agent-ops-daily-report`, `notify-agent-collection-lapse` — were deployed one at
a time by name. `notify-agent-collection-lapse` mattered beyond reporting: it
infers a tenant's payment cadence from gaps between collections, so counting a
reversed collection would read as a shorter gap and could lock an agent against
a schedule they never kept.

`deploy-edge-function.yml` was extended to reach these three. Its blanket
"refuse any function with a `config.toml` entry" check was replaced with a
per-function `EXPECT_PUBLIC` assertion that **fails in both directions** — an
unexpected entry appearing on a JWT function, or a cron-invoked report quietly
losing the `verify_jwt = false` that keeps its scheduler able to call it.

---

## 8. The fix — Phase 4: making the numbers mean something

With the data correct, the **display** was still wrong. Three separate defects,
all in how the day was measured.

### a. Timezone mismatch

`get_agent_ops_overview` compared `v_today` — a Kampala date — against
`created_at::date`, a UTC cast. Different day boundaries entirely. On 2026-09-16
the UTC basis read 47,360,951 and the Kampala basis 51,072,299: a 3.7M
discrepancy against a bill that is always a Kampala day.

### b. Incomparable numerator

`collections_today` is **all cash in the door**, most of it tenants clearing
older debt. That is real money, but it is not progress against today's bill. Put
beside `expected` it read as ~840% coverage. The key was left alone — it is not
wrong, it answers a different question — and like-for-like companions were added
beside it: `expected_today`, `plans_billed_today`,
`collected_on_schedule_today`, `pending_today`.

### c. Pending clamped to zero

The "Pending Collections" tile computed `expected − collected` with negatives
clamped to zero, using the **uncapped** on-schedule figure — every shilling paid
against any plan billed in the window, however far above that plan's daily
amount. On 2026-09-16 that is 18,249,084 against a 6,080,933 bill, so the
subtraction went negative and **the tile showed zero pending on a day with 4.3M
genuinely outstanding.**

Uncapped is the right basis for "how much cash arrived". It is the wrong basis
for "are agents keeping up", because one tenant overpaying covers another who
paid nothing. Capped companions were added rather than changing existing keys:
`collected_on_schedule_capped`, `pending_capped`, `coverage_pct_capped`.

### d. Expected everywhere from the pinned bill

`agent_expected_day_plans` **is the bill**: one row per plan per day, written
once at 00:05 EAT by `pin_agent_expected_day`, never changed. Several surfaces
ignored it and re-derived expected live from `rent_requests.daily_repayment`,
which sums every plan active on the day regardless of what was billed.

The two are not close. On 2026-09-16:

| Basis | Expected |
| --- | ---: |
| Pinned bill | **UGX 6,080,933** |
| Live `daily_repayment` sum | UGX 14,466,570 — **238% of the bill** |

Worse, `get_agent_ops_overview` used the **pin** for its KPI tiles and the
**live** basis for its trend chart — so the chart contradicted the tiles
directly above it. Fixed in `get_agent_ops_overview`,
`ops_tenant_ops_weekly_bundle` and both overloads of
`get_agent_products_services_report`.

`expected_cumulative` previously multiplied a plan's daily amount by days
elapsed since funding. That models what *should* have been billed, not what was:
it cannot know about a plan funded mid-window, a pin never written, or a
back-dated term start. Summing the pins answers the same question **from the
record rather than from arithmetic**.

---

## 9. The figures, correctly stated

For **2026-09-16**, arrears excluded where the label says so:

| Figure | Amount | What it means |
| --- | ---: | --- |
| **Expected today** | **UGX 6,080,933** | the pinned bill |
| Total collected (all cash) | UGX 51,072,299 | correct, but **includes arrears** — not comparable to expected |
| On-schedule, uncapped | UGX 18,249,084 | the figure that made pending read zero |
| **Collected on schedule (capped)** | **UGX 1,801,579** | progress against today's bill |
| **Pending** | **UGX 4,279,354** | genuinely outstanding |
| Coverage | **29.6%** | capped basis |

`1,801,579 + 4,279,354 = 6,080,933` ✓ — Total Collected now reconciles with
Expected and Pending.

**Never divide total collected by expected.** Four figures, not one ratio. This
is the trap documented in
[`agent-expected-bill-and-arrears-gaps.md`](./agent-expected-bill-and-arrears-gaps.md):
the bill and the receipt book are different books, and dividing their totals
overstates coverage.

---

## 10. Verification at close

Run against live production after all migrations applied:

| Check | Result |
| --- | --- |
| Collections since the fix | 30 |
| Float legs since the fix | 30 — **1:1** |
| Collections with stale float (`float_before = float_after`) | **0** |
| `assert_money_path_intact()` failing checks | **0** |
| Money readers not excluding reversed rows | **0** |
| Wallets displaying a negative balance | **0** |

---

## 11. Open items and recommendations

Ordered by what I would act on first.

### 1. Aggregate raw float is **−247,810,114** across all agents — INVESTIGATE

The displayed balance is `GREATEST(0, float_raw)` in `wallet_strict_for_user`, so
the clamp hides it completely: every wallet reads zero-or-positive while the
underlying ledger sum is a quarter of a billion negative.

This **predates this incident** — it was already −3,066,884 across just the 38
affected agents before 15 September — and nothing in this remediation touches it.
It is not yet known whether it is a real deficit, an artefact of how float
top-ups and settlements are categorised, or legacy rows before a fresh-start
anchor.

**Recommendation:** this needs its own investigation before any float figure is
treated as trustworthy. It is also an argument for surfacing raw float alongside
the clamped value on an internal screen, so a deficit of this size cannot sit
invisible again.

### 2. The A2 classification — CFO decision, blocks a known-wrong posting

Agent-funded float is a **liability** (the platform owes the agent); platform-
advanced float is an **asset**. Both currently share one bucket. Until that is
settled, `tenant_repayment_collected` posts `cash_in`, which maps to a **debit**
of A3 and so *raises* the tenant receivable where it should fall. `0114`
identified this correctly — it was the one thing it got right.

This was left deliberately undecided in `20260916120000`. It is the root cause
behind this accounting being redesigned twice, and it will be redesigned a third
time until the classification is settled.

### 3. The 2-minute duplicate rule is a heuristic

117 ambiguous rows (UGX 12,768,923) were treated as genuine, deliberately erring
toward agents and tenants. If any were duplicates, that money stays uncorrected.
**Recommendation:** spot-check a sample of those 117 against agent receipts. If
they are duplicates, the rule needs a second pass; if they are genuine, the
trade-off is confirmed and can be closed.

### 4. Reconcile the tenant credit figure

Pre-flight estimate 144 plans / UGX 8,276,097; applied 137 plans / UGX 8,463,764.
Explicable, not reconciled. See §6.

### 5. Confirm the basis of the UGX 15,152,134 commission figure

Reported elsewhere as "already net of reversals". That only covers the
2,285,902.18 clawed back — the 6,979,766.12 written off is still in there as
genuinely paid, because it *was* paid. Worth confirming which basis the figure
is on before it reaches a board pack.

### 6. `cap.expected_daily` is mislabelled

In `ops_tenant_ops_weekly_bundle`, the `cap` CTE still sums live
`daily_repayment` across an agent's whole book. That is a **capacity** measure —
"how much does this agent's book bill per day" — and is not window-scoped, so
the pin is not the right source for it. Mislabelled rather than wrong. Renaming
it is a UI change and belongs to Gemini.

### 7. Migrations are not recorded in `supabase_migrations.schema_migrations`

Zero rows. These were applied directly, as this project has always done. All are
idempotent (each opens with an "already applied" guard), so a future runner
picking them up is safe — but the repository and the live schema remain two
different sources of truth. This is the same gap that let `0114` happen.

### 8. Process — the recommendation underneath all of the above

Three incidents in seven days, all the same shape: **a money-path RPC changed
directly in production, outside a reviewed migration.** The drift detector now
catches it within ten minutes. That is detection, not prevention. Prevention is
a rule that direct DDL on money-path functions is not available to the tools that
did it — and that rule does not yet exist.

---

## 12. Corrections made during the response

Recorded because each one would have gone into a report as fact.

**`LEAST(NULL, x)` returns `x` in Postgres, not `NULL`.** I first reported
coverage of 99.2% (15 Sept) and 99.7% (16 Sept). Plans that paid *nothing* were
being counted as fully paid. Caught when 171 plans had paid nothing yet pending
showed 21,410. **Corrected figures: 47.0% and 29.6%.**

**A false 982,017,501 clawback reading.** The first verification filter was too
loose: 1,295 **historical** legs from June–August share the `duplicate_reversal`
enum value. The actual write was 20 legs / 2,285,902.18. Checked before
reporting.

**The duplicate rule was initially too aggressive.** A day-level rule caught 117
rows more than two minutes apart that could be genuine second payments. Narrowed
to the 2-minute burst rule **before** deploying; clawback fell from 2,846,236 to
2,285,342.

**`clock_timestamp()` vs `now()`.** Ledger legs stamp `now()` — transaction start
— so a `>= clock_timestamp()` test filter found nothing and reported commission
= 0 spuriously. Re-run with `>= now()`.

---

## 13. Appendix

### Migrations

| File | What it does |
| --- | --- |
| `20260916100000_freeze_agent_allocate_tenant_payment_float_gap.sql` | emergency stop |
| `20260916120000_restore_float_consumption_on_collection.sql` | **the core fix** |
| `20260916130000_restore_agent_collection_float_cap_and_unfreeze.sql` | neutralised to a documented no-op |
| `20260916180000_reverse_duplicate_collections_and_claw_back_commission.sql` | 1,210 reversed, 2,285,902.18 recovered |
| `20260916190000_money_path_drift_detector.sql` | 11 invariants, every 10 min |
| `20260916200000_credit_tenants_whose_repayments_were_dropped.sql` | 137 plans, 8,463,764 |
| `20260916210000` / `230000` / `240000` | reporting sweep batches 2, 3, final |
| `20260916220000_contra_the_duplicate_collection_ledger_legs.sql` | books balanced |
| `20260916250000_agent_ops_today_figures_and_capped_coverage.sql` | Kampala day, capped pending |
| `20260916260000_expected_everywhere_from_the_pinned_bill.sql` | expected on the pin |

### Commits (`lovable`, 2026-09-16)

`2587e556b` · `d6dc0ea98` · `40940acff` · `43f1f527a` · `c9eccaac7` ·
`407e51ca0` · `f57ba6d9e` · `d3d034bf5` · `159548782` · `12d70f15a` ·
`9aaafdfd2` · `449a22dc8` · `9c96c3ada`

### Related documents

- [`2026-09-10-inverted-collection-incident.md`](./2026-09-10-inverted-collection-incident.md) — the first of the three
- [`reversed-collections-surface-audit.md`](./reversed-collections-surface-audit.md) — full classified surface inventory
- [`agent-expected-bill-and-arrears-gaps.md`](./agent-expected-bill-and-arrears-gaps.md) — the bill vs the receipt book
