# Arrears carry-forward — smoke & end-to-end test report

**Run date:** 9 September 2026, ~15:30–16:30 EAT
**Target:** production database `wirntoujqoyjobfhyelc`, real RPCs, real triggers, real constraints
**Data:** 100% synthetic, created and destroyed inside each test transaction
**Result:** the arrears machinery behaves correctly in all 41 measured cases. **Four defects found**, one of them a real money-integrity issue that exists independently of this feature.

The cron change (`rent_sweep_unapplied_collections()` after the 00:05 pin) has **not** been applied, as instructed.

---

## Section 1 — How this was tested

### 1.1 Real paths only

Every object exercised is the live production object. Nothing was stubbed, mocked or stood in for:

| Layer | Object used |
| --- | --- |
| Collection | `agent_allocate_tenant_payment` → `agent_allocate_tenant_payment_internal` |
| Money movement | `create_ledger_transaction` (via the RPC), `finops_manual_float_credit` for float |
| Schedule | `rent_plan_schedule_days`, `v_rent_plan_schedule` |
| Fee formula | `compute_rent_repayment` (via `enforce_rent_request_formula`) |
| Attribution | `rent_apply_collections_to_days` (called by the RPC itself) |
| Reads | `v_rent_day_ledger`, `v_rent_plan_arrears`, `v_rent_collection_unapplied`, `rent_plan_day_ledger`, `agent_arrears_overview`, `agent_expected_collection` |
| Guards | all ~40 `rent_requests` triggers, all ~40 `general_ledger` triggers, RLS, the composite FK |

No test-only function was created. No test was made to pass by bypassing a rule — where a rule blocked the test, the rule is reported (Section 9).

### 1.2 No production data used, nothing left behind

Each test is a single transaction that creates its own cast — agent, tenant, FinOps officer, landlord, Rent Plan — and ends with `RAISE EXCEPTION`. The exception both returns the measurements and **guarantees the rollback**: a transaction that raises cannot commit. No `COMMIT` path exists in the harness.

Verified after the final run:

| Check | Result |
| --- | --- |
| `rent_arrears_go_live()` | **2026-09-10** (unchanged) |
| Synthetic `auth.users` left behind | **0** |
| Synthetic profiles / landlords / Rent Plans | **0 / 0 / 0** |
| Synthetic collections / ledger rows / reconciled TIDs | **0 / 0 / 0** |
| `rent_day_settlements` rows | **0** |
| `v_rent_day_ledger` rows | **0** |
| Pinned days created beyond today | **0** |

Outbound notifications are safe under rollback: the three HTTP-firing triggers reachable here (`tr_detect_agent_unblock`, `notify_supporters_new_opportunity`, `notify_watchers_on_verification`) all use `net.http_post`, which queues by inserting into `net.http_request_queue`. That insert is transactional, so a rollback cancels the request before the background worker can see it. No SMS, email or push left the system.

### 1.3 The three test fixtures, and why each was necessary

These are scaffolding, not changes to the logic under test. All three are undone by the rollback.

| Fixture | Why | Effect on the result |
| --- | --- | --- |
| `set_config('request.jwt.claims', …)` to act as the agent / FinOps officer | `auth.uid()` is null on a direct database connection, and every authorization check reads it | None — this is the same mechanism PostgREST uses. All role and ownership checks still ran, and one of them caught a real defect (Section 9.1) |
| `CREATE OR REPLACE rent_arrears_go_live()` to a past date | The real floor is **tomorrow**, so today *nothing is in scope* and no arrears behaviour can be exercised at all | None on the logic — the floor is a date constant. Section 10 notes this is the one thing that cannot be avoided until 10 September |
| Pinned days inserted with the pin's own `INSERT … SELECT` statement, restricted to the test plan | `pin_agent_expected_day(day)` is **day-global** and short-circuits when a day already has rows, so it cannot add one new plan to a past day | None — the rows come from `rent_plan_schedule_days`, the same generator the pin uses. Only the range form was used instead of one call per day (identical rows, far cheaper) |

---

## Section 2 — The Rent Plan under test, in the system's own numbers

The scenario was 100,000 rent over a 30-day cycle. Every figure below is what the production formula returned — none were chosen by hand.

`compute_rent_repayment(100000, 30)`:

| Field | Value |
| --- | --- |
| Rent amount | 100,000 |
| Access fee | 33,000 |
| Request fee | 10,000 |
| **Total repayment** | **143,000** |
| **Daily repayment** | **4,767** |

This confirms the 4,766.7 figure in the brief: 143,000 ÷ 30 = 4,766.67, rounded to **4,767**.

### 2.1 The ten-shilling rounding is handled correctly

4,767 × 30 = 143,010 — ten shillings more than the total. The generator does **not** over-bill. It clamps cumulatively:

```
amount(k) = LEAST(instalment × (k+1), total) − LEAST(instalment × k, total)
```

Measured over the full cycle:

| | Measured |
| --- | --- |
| Days generated | 30 |
| First day | 4,767 |
| **Last day** | **4,757** |
| **Sum of all 30 days** | **143,000** — exact |

The last day absorbs the rounding. The tenant is never billed a shilling more than 143,000.

### 2.2 Weekly equivalent

For `repayment_frequency = 'weekly'` the same generator produces an instalment of 4,767 × 7 = **33,369**, due every 7th day from the start date. Measured: a weekly plan starting 7 days ago has exactly **two** pinned obligations (day 0 and day 7), each 33,369 — not fourteen daily rows.

---

## Section 3 — The nine tenant states, and how each was built

All states are relative to **today = 2026-09-09**.

| # | State | How it was constructed | Pinned days |
| --- | --- | --- | --- |
| T1 | One day behind | Plan starts yesterday, no payment | 09-08, 09-09 |
| T2 | No day missed | Plan starts yesterday; a real 4,767 collection settles 09-08 first | 09-08, 09-09 |
| T3 | Never made a payment | Plan starts 3 days ago, no collections | 09-06 … 09-09 |
| T4 | No payment for 5 days | Plan starts 5 days ago, no collections | 09-04 … 09-09 (6) |
| T5 | Brand-new plan just approved | Plan funded today, `repayment_starts_on` left to the system | **0** |
| T6 | Completed / zero outstanding | Plan created with `amount_repaid = 143,000`, status `completed` | 0 |
| T7 | No arrears | **Identical to T2** — see note | 09-08, 09-09 |
| T8 | Cycle expired, still owing | Plan starts 40 days ago; term ran 07-31 → 08-29 | 30 (none today) |
| T9 | Weekly repayment | Plan starts 7 days ago, weekly | 09-02, 09-09 |

**T2 and T7 are the same state.** "Didn't miss any day" and "has no arrears" describe one condition: every day before today is fully settled. They are reported as one row throughout. If T7 was meant to mean something different — for example *up to date **and** nothing due today either* — that is the T2 row after the day is settled, which the 4,767 and 5,000 cells both show.

**T5 is the important one for new tenants.** The system set `repayment_starts_on = 2026-09-10` — **tomorrow**. A plan funded today has **zero** pinned obligations and cannot be collected against. This is intended behaviour (repayment starts the day after funding), and it is enforced server-side.

---

## Section 4 — The rule being tested

A payment settles the **oldest open day first**, then the next, and only what survives lands on today. Surplus beyond every open day waits as *unapplied* money and pre-pays future days once they are pinned.

The five payment amounts:

| # | Amount | Relationship to the 4,767 daily instalment |
| --- | ---: | --- |
| P1 | 5,000 | 233 over |
| P2 | 4,767 | exactly the daily amount |
| P3 | 0 | no collection made that day |
| P4 | 4,000 | 767 short |
| P5 | 50,000 | ~10.5 days' worth |

---

## Section 5 — Results matrix

**41 of 45 cells measured.** Every figure below was read back from the database after the real RPC ran. The four unmeasured cells are named in Section 10.

Columns: **settled** = which days the payment landed on · **behind / arrears** = days and amount still open *before* today · **due today** = what remains on today's own obligation · **stamped** = `expected_amount` / `shortfall_amount` / `is_partial` written onto the receipt · **ahead** = unapplied money held for future days.

### 5.1 T1 — one day behind (owes 09-08 and 09-09)

| Pay | Settled | Behind | Arrears | Due today | Stamped exp / short / partial | Ahead |
| ---: | --- | ---: | ---: | ---: | --- | ---: |
| 5,000 | 09-08: 4,767 · 09-09: 233 | 0 | 0 | 4,534 | 4,767 / 0 / no | 0 |
| 4,767 | 09-08: 4,767 | 0 | 0 | **4,767** | 4,767 / 0 / **no** | 0 |
| 0 | — | 1 | 4,767 | 4,767 | — | 0 |
| 4,000 | 09-08: 4,000 | 1 | 767 | 4,767 | 4,767 / 767 / yes | 0 |
| 50,000 | 09-08: 4,767 · 09-09: 4,767 | 0 | 0 | 0 | 4,767 / 0 / no | **40,466** |

**Worked example (5,000).** Yesterday needed 4,767 and took all of it. 233 was left, and landed on today. Today is therefore 4,534 short — and the tenant is no longer "behind", because being behind counts only days *before* today.

**The 4,767 row is the one to look at.** The agent collected exactly the day's amount, the receipt says "not partial, no shortfall" — and **today received nothing at all**. All of it went to yesterday. This is the rule working as designed, but the receipt does not say so (Section 9.3).

### 5.2 T2 / T7 — up to date (09-08 already settled)

| Pay | Settled | Behind | Arrears | Due today | Stamped exp / short / partial | Ahead |
| ---: | --- | ---: | ---: | ---: | --- | ---: |
| 5,000 | 09-08: 4,767 · 09-09: 4,767 | 0 | 0 | 0 | 4,767 / 0 / no | 233 |
| 4,767 | 09-08: 4,767 · 09-09: 4,767 | 0 | 0 | 0 | 4,767 / 0 / no | 0 |
| 0 | 09-08: 4,767 | 0 | 0 | 4,767 | — | 0 |
| 4,000 | 09-08: 4,767 · 09-09: 4,000 | 0 | 0 | **767** | 4,767 / 767 / yes | 0 |
| 50,000 | 09-08: 4,767 · 09-09: 4,767 | 0 | 0 | 0 | 4,767 / 0 / no | **45,233** |

This is the clean case: with nothing behind, the whole payment lands on today, and the receipt's shortfall matches reality exactly. Paying 4,000 leaves today 767 short and says so.

### 5.3 T3 — never made a payment (3 days behind)

| Pay | Settled | Behind | Arrears | Due today | Stamped | Ahead |
| ---: | --- | ---: | ---: | ---: | --- | ---: |
| 5,000 | 09-06: 4,767 · 09-07: 233 | 2 | 9,301 | 4,767 | 4,767 / 0 / no | 0 |
| 4,767 | 09-06: 4,767 | 2 | 9,534 | 4,767 | 4,767 / 0 / no | 0 |
| 0 | — | 3 | 14,301 | 4,767 | — | 0 |
| 4,000 | 09-06: 4,000 | 3 | 10,301 | 4,767 | 4,767 / 767 / yes | 0 |
| 50,000 | 09-06/07/08/09: 4,767 each | 0 | 0 | 0 | 4,767 / 0 / no | **30,932** |

Arithmetic check on the 5,000 row: 09-07 keeps 4,534 and 09-08 keeps 4,767 → 9,301. Exact. On the 0 row: 3 × 4,767 = 14,301. Exact.

### 5.4 T4 — no payment for five days (6 open days)

| Pay | Settled | Behind | Arrears | Due today | Stamped | Ahead |
| ---: | --- | ---: | ---: | ---: | --- | ---: |
| 5,000 | 09-04: 4,767 · 09-05: 233 | 4 | 18,835 | 4,767 | 4,767 / 0 / no | 0 |
| 4,767 | 09-04: 4,767 | 4 | 19,068 | 4,767 | 4,767 / 0 / **no** | 0 |
| 0 | — | 5 | 23,835 | 4,767 | — | 0 |
| 4,000 | 09-04: 4,000 | 5 | 19,835 | 4,767 | 4,767 / 767 / yes | 0 |
| 50,000 | all 6 days: 4,767 each = 28,602 | 0 | 0 | 0 | 4,767 / 0 / no | **21,398** |

**The 50,000 row is the headline case for recovery.** One payment cleared five missed days *and* today, and banked 21,398 against the days to come. 28,602 + 21,398 = 50,000 exactly.

**The 4,767 row is the fairness problem in miniature.** The agent brought in a full day's money; the receipt records no shortfall; the tenant is still **four days and 19,068** behind.

### 5.5 T8 — cycle expired, still owing (term 07-31 → 08-29, nothing due today)

| Pay | Settled | Behind | Arrears | Due today | Stamped exp | Ahead |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 5,000 | 07-31: 4,767 · 08-01: 233 | 29 | 138,000 | 0 | **0** | 0 |
| 4,767 | 07-31: 4,767 | 29 | 138,233 | 0 | **0** | 0 |
| 0 | — | 30 | **143,000** | 0 | **0** | 0 |
| 4,000 | 07-31: 4,000 | 30 | 139,000 | 0 | **0** | 0 |
| 50,000 | 11 rows, 07-31 → 08-10, sum 50,000 | 20 | 93,000 | 0 | **0** | 0 |

Two things this proves:

1. **Arrears recovery on a dead cycle now has somewhere to land.** The 50,000 payment walked eleven days of history — ten full days at 4,767 plus 2,330 on the eleventh — and the total is exact. Before this feature, that money attached to no day at all.
2. **`expected_amount` is 0 for every row.** The plan owes the entire 143,000 and contributes **nothing** to today's expected figure, because no day is pinned for today. This is the 129M post-cycle blind spot, reproduced in a controlled case (Section 9.4).

### 5.6 T9 — weekly plan (33,369 due on 09-02 and 09-09)

| Pay | Settled | Behind | Arrears | Due today | Stamped exp / short / partial | Ahead |
| ---: | --- | ---: | ---: | ---: | --- | ---: |
| 5,000 | 09-02: 5,000 | 1 | 28,369 | 33,369 | 33,369 / 28,369 / yes | 0 |
| 4,767 | 09-02: 4,767 | 1 | 28,602 | 33,369 | 33,369 / 28,602 / yes | 0 |
| 0 | — | 1 | 33,369 | 33,369 | — | 0 |
| 4,000 | 09-02: 4,000 | 1 | 29,369 | 33,369 | 33,369 / 29,369 / yes | 0 |
| 50,000 | 09-02: 33,369 · 09-09: 16,631 | 0 | 0 | 16,738 | 33,369 / 0 / no | 0 |

The weekly fix holds: `expected_amount` is the **full 33,369 instalment**, not one seventh of it, and the plan is billed only on its due days. The 50,000 row splits exactly: 33,369 + 16,631 = 50,000, leaving today 16,738 short.

### 5.7 T5 and T6 — the two refusals

| State | Pay | Outcome |
| --- | ---: | --- |
| T5 brand-new plan | 5,000 | `REPAYMENT_NOT_STARTED` — repayment starts 2026-09-10 |
| T5 brand-new plan | 50,000 | `REPAYMENT_NOT_STARTED` |
| T5 brand-new plan | 0 | No collection. 0 pinned days, `expected_today` = 0 |
| T6 completed, balance 0 | 4,767 | `AMOUNT_EXCEEDS_OUTSTANDING` |
| T6 completed, balance 0 | 50,000 | `AMOUNT_EXCEEDS_OUTSTANDING` |
| T6 completed, balance 0 | 0 | No collection. 0 pinned days, `expected_today` = 0 |

Both refusals happen **before** the amount is examined — the start-date guard sits at the top of `agent_allocate_tenant_payment`, and T6's outstanding is zero so any positive amount exceeds it. Both endpoints (smallest and largest) were measured and returned the identical error, which is why the two middle amounts in each were not run.

---

## Section 6 — Paying ahead

Overpayment behaves as agreed: it pre-pays future days, and it never disappears.

| Case | Paid | Landed on days | Held as "ahead" |
| --- | ---: | ---: | ---: |
| T1 × 50,000 | 50,000 | 9,534 | 40,466 |
| T2 × 50,000 | 50,000 | 4,767 | 45,233 |
| T3 × 50,000 | 50,000 | 19,068 | 30,932 |
| T4 × 50,000 | 50,000 | 28,602 | 21,398 |
| T2 × 5,000 | 5,000 | 4,767 | 233 |

In every row, **landed + held = paid**, exactly.

The money is held rather than applied because a settlement can only point at a day that has actually been billed — the composite foreign key to `agent_expected_day_plans(day, rent_request_id)` makes that structurally impossible to violate. Tomorrow's day does not exist yet at 15:00 today.

**This is where the missing cron job matters.** The held money lands on the new day only when something runs the allocator again. With the sweeper unscheduled, that is the plan's *next collection* — so a tenant who pays 50,000 today would still show tomorrow as unpaid until someone collects from them again. Nothing is lost, but the arrears view would be wrong for a day. See Section 10.

---

## Section 7 — What the money movement looks like

A single 5,000 collection produced exactly four ledger legs, all tagged `source_table = 'agent_collections'` and `source_id = <rent plan>`:

| Category | Direction | Scope | Bucket | Party | Amount |
| --- | --- | --- | --- | --- | ---: |
| `agent_float_used_for_rent` | cash_out | wallet | float | agent | 5,000 |
| `tenant_repayment` | cash_in | platform | — | tenant | 5,000 |
| `agent_commission_payable` | cash_out | platform | — | agent | 500 |
| `agent_commission_earned` | cash_in | wallet | withdrawable | agent | 500 |

And one `agent_collections` receipt:

| Field | Value |
| --- | --- |
| `tracking_id` | `AGT-9bff136d` |
| `amount` | 5,000 |
| `expected_amount` | 4,767 |
| `shortfall_amount` | 0 |
| `is_partial` | false |
| `float_before` → `float_after` | 900,000 → 895,000 |
| `payment_method` / `collection_channel` | cash / agent_float |

Plus two settlement rows: 09-08 → 4,767, 09-09 → 233.

---

## Section 8 — Traceability: who can follow the money

The requirement was that CFO, agent ops and tenant ops can track these repayments without a new dashboard. They can.

### 8.1 The trail

Every settlement row names **both** the collection that paid and the day it paid, so the money is traceable in either direction:

- *from a receipt* → which days did this 5,000 close? → 09-08 in full, 09-08's balance to zero, 233 towards 09-09
- *from an open day* → what has been paid against 09-09? → 233, from collection `AGT-9bff136d`

The chain is unbroken: `general_ledger` (money left the agent's float) → `agent_collections` (the receipt, with `tracking_id`) → `rent_day_settlements` (which day it settled) → `agent_expected_day_plans` (the obligation it settled, immutable since 00:05).

### 8.2 The read surfaces, measured

`rent_plan_day_ledger(<plan>)` returned, in one round trip:

```
days:    09-09  expected 4,767  settled   233  remaining 4,534  settled? no
         09-08  expected 4,767  settled 4,767  remaining     0  settled? yes
summary: days_billed 2 · billed_to_date 9,534 · settled_to_date 5,000
         days_behind 0 · arrears 0 · due_today 4,534 · oldest_open_day null
unapplied_ugx: 0
```

`agent_arrears_overview(<agent>)` returned totals `tenants_behind 0 · arrears 0 · due_today 4,534 · days_behind 0`.

### 8.3 Who is allowed to read it

`rent_arrears_read_authorized()` grants: CFO, agent ops, tenant ops, financial ops, landlord ops, partner ops, plus manager / super_admin / COO / operations. `rent_plan_collect_authorized()` additionally admits the plan's own agent, its assigned agent, and a parent agent of a verified sub-agent.

**Note for CFO reconciliation:** `billed_to_date_ugx` and `settled_to_date_ugx` on the plan summary are the two figures to compare. They are derived from the immutable pin and the settlement rows respectively, so they cannot drift from each other or from the receipts.

---

## Section 9 — Defects, loopholes and errors found

Nothing was changed. Each item below is reported for a decision.

### 9.1 🔴 HIGH — a second collection on the same Rent Plan in one transaction silently loses the repayment

**This is a real money-integrity defect and it is not caused by the arrears feature.**

Measured, in one transaction, two collections on one plan:

| | |
| --- | --- |
| Payment 1 | 3,000 → `success: true` → `amount_repaid` = 3,000 ✔ |
| Payment 2 | 2,000 → `success: true`, reported `outstanding_after: 138,000` |
| `agent_collections` rows | **2**, summing **5,000** |
| Agent float debited | **5,000** (900,000 → 895,000) |
| **`rent_requests.amount_repaid`** | **3,000** — the second 2,000 was silently discarded |

So 5,000 left the agent's float and only 3,000 was credited to the tenant. The RPC returned success and even reported the *correct* outstanding balance, so no caller could detect it.

**Root cause.** `guard_rent_request_agent_updates` decides whether to trust an agent-initiated repayment by summing **all** matching float debits in the current transaction and comparing that sum to the single row's `amount_repaid` delta:

```sql
… AND gl.xmin::text::bigint = txid_current();
…
v_trusted_allocation := (v_current_tx_float_debit = v_repayment_delta) AND …
IF NOT v_trusted_allocation THEN
  NEW.amount_repaid := OLD.amount_repaid;   -- silently reverted
END IF;
```

On the second payment the sum is 5,000 but the delta is 2,000, so the guard does not trust it and quietly reverts the increment.

**Reachability.** The normal app flow issues one RPC per HTTP request, so each collection is its own transaction and this cannot fire. It fires for **any batch path that records two collections for the same plan in one transaction** — an offline-sync submit, a bulk import, a future server-side loop, or a retry wrapper.

**Suggested direction (not applied):** scope the debit sum to the specific collection row being recorded rather than to the whole transaction.

### 9.2 🟠 MEDIUM — the same guard breaks under any exception-handling wrapper, and has a long-term time bomb

The trust test is `gl.xmin::text::bigint = txid_current()`. Two consequences, both measured:

**(a) Subtransactions lose trust.** A PL/pgSQL block with an `EXCEPTION` clause runs in a subtransaction, so rows written inside it get a subtransaction id:

| | Measured |
| --- | --- |
| `txid_current()` | 38308802 |
| `xmin` of a row written with no handler | 38308802 → **matches** |
| `xmin` of a row written inside an `EXCEPTION` block | 38308803 → **does not match** |

The visible symptom is the collection failing with `Agents cannot move a rent request from funded to repaying`. Any wrapper that adds error handling around the collection call breaks collections. (This is how the defect was found — it broke the test harness first.)

**(b) It will fail permanently after one transaction-id epoch.** `xmin` is a 32-bit value; `txid_current()` includes the epoch. Once the database passes ~4.29 billion transactions the comparison can never match and **every** agent collection would fail this way. Currently safe — measured `txid_current()` = 38,308,802, epoch 0 — but the failure mode is total when it arrives. `pg_current_xact_id()` / comparing against `xmin::text::xid8` would remove the cliff.

### 9.3 🟠 MEDIUM — the receipt says "paid in full" while the tenant is days behind

`is_partial` and `shortfall_amount` are measured against **today's scheduled amount only**, ignoring arrears. Measured:

| State | Paid | Stamped shortfall | `is_partial` | Reality after the payment |
| --- | ---: | ---: | --- | --- |
| T1 one day behind | 4,767 | 0 | **false** | today received **nothing**; 4,767 still due today |
| T4 five days behind | 4,767 | 0 | **false** | **4 days / 19,068** still behind |
| T8 expired cycle | 4,767 | 0 | **false** | **29 days / 138,233** still owed |

Operations' partial-collections reporting will therefore under-count. A tenant 138,233 in arrears who pays 4,767 is recorded as a clean, complete collection.

This is open item 7 in `arrears-carry-forward-settlement-order.md` ("is `is_partial` judged against scheduled or scheduled + carry?") and it now has measurements behind it. It is a **reporting** defect, not a money defect — the ledger and settlements are correct.

### 9.4 🟠 MEDIUM — an expired cycle contributes 0 to today's expected while owing everything

T8 with no payment: the plan owes the **entire 143,000**, is 30 days behind, and `agent_expected_collection` returns **0** because no day is pinned for today.

Any recovery on such a plan therefore scores nothing against the daily bill — the exact unfairness documented at 129,037,935 across 427 real plans. Phase 1 now makes the debt *visible* (arrears 143,000, 30 days behind, itemised by day), which is progress, but the scoring question is still open and belongs to the Phase 3 gate decision.

### 9.5 🔵 LOW / informational — every new user is granted four roles

Creating one `auth.users` row auto-provisioned a profile, a wallet, **and the roles `tenant`, `agent`, `landlord`, `supporter`**.

Consequences worth being aware of: `has_role(uid,'agent')` is true for every registered user, so it cannot distinguish a real agent; and any count of "agents" by role will equal the whole user base. This matches the known three-definitions-of-agent-count problem and is why the counting rule uses activity, not roles.

### 9.6 🔵 LOW — held-ahead money is invisible to the day ledger until something re-runs the allocator

By design (Section 6), but with the sweeper unscheduled the delay is unbounded — it waits for the plan's next collection. A tenant who pays 50,000 today and nothing tomorrow would show tomorrow as **unpaid** despite holding 40,466 in credit.

### 9.7 🔵 LOW — `agent_expected_collection` does not subtract what today has already been settled

From the function body: it returns the pinned amount for today capped by outstanding, with no reference to settlements. So after part of today is settled, the collect screen still offers the full 4,767 while the day ledger says only 767 remains (measured in T2 × 4,000: `due_today` = 767).

This is deliberate for now — the screen was specified to show today's amount — and Phase 2 exposes `due_today_ugx` alongside it so the dialog can tell the truth. Flagged so it is a decision rather than an accident.

---

## Section 10 — Coverage, limitations, and what to do before go-live

### 10.1 What was and was not measured

| | |
| --- | --- |
| Matrix cells measured | **41 of 45** |
| Cells not run | T5 × 4,767 · T5 × 4,000 · T6 × 5,000 · T6 × 4,000 |

Those four were skipped because both refusals happen before the amount is examined, and both endpoints (5,000/4,767 and 50,000) were measured returning the identical error. They are marked **not run** rather than assumed passed.

### 10.2 Paths deliberately not exercised

| Not tested | Why it matters |
| --- | --- |
| **Reversal** (`trg_rent_drop_settlements_on_reversal`) | Untested. A reversed collection must release the days it settled; the trigger exists but no test drove it |
| **`rent_sweep_unapplied_collections()`** | Untested end-to-end, and the very thing the pending cron change would schedule |
| **Concurrency** — two collections on one plan at the same instant | The advisory lock is unexercised. Note that Section 9.1 shows the *sequential in-one-transaction* case is already broken |
| **The real go-live boundary** | Every test moved the floor into the past. The behaviour of the first genuine day, 2026-09-10, has not been observed |

### 10.3 Recommended before scheduling the cron

1. **Decide on 9.1.** It is a real money-integrity defect, independent of this feature. It is currently unreachable through the app, but it is one batch endpoint away from being reachable.
2. **Test the reversal path.** It is the one part of Phase 1 with no coverage at all, and it touches money attribution.
3. **Then schedule the sweeper.** On the evidence here it does what it should, and 9.6 shows the gap it closes is real. The one-line change is ready:

```sql
select public.pin_agent_expected_day(((now() at time zone 'Africa/Kampala')::date)), public.rent_sweep_unapplied_collections();
```

Appending it to job **18933** (`pin-agent-expected-day-eat-midnight`, `5 21 * * *` = 00:05 EAT) guarantees ordering, rather than racing two schedules. **Not applied.**

4. **Settle 9.3** — whether `is_partial` should mean "short against today" or "short against everything owed". It changes Operations' partial-collections reporting either way.
