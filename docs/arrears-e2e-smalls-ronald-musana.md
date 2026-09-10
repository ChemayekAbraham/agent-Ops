# Arrears & partial payments — end-to-end test on a live tenant

**Subject:** SMALLS Ronald Musana · **Agent:** SSENKAALI PIUS · **Date:** 10 September 2026
**Plan:** `7a02c339-2538-42cf-9ef2-2f1950dfde18` · **Coverage:** 45 of 45 cells (5 payment amounts × 9 tenant states)
**Result:** the engine behaved correctly in **every** cell. Five defects reported, none of them new failures of the arrears engine itself.

**Nothing was changed.** Every test ran inside a transaction that was deliberately rolled back. His plan, his payments and his agent's float are exactly as they were.

---

## Section 1 — The subject, and why no numbers were invented

His real plan already matches the brief exactly, so nothing had to be made up.

| Field | Live value |
| --- | ---: |
| Rent amount | **100,000** |
| Duration | **30 days** |
| Access fee | 33,000 |
| Request fee | 10,000 |
| **Total repayment** | **143,000** |
| **Daily repayment** | **4,767** |
| Repayment starts | 2026-09-09 |
| Term ends | 2026-10-08 |
| Repaid to date | 55,000 (2 collections, both 8 Sep) |
| Outstanding | 88,000 |
| Status | repaying |
| **Agent's operational float** | **195,300** |

The brief's "4,7667" is the system's own **4,767** — 143,000 ÷ 30 = 4,766.67, rounded.

**The 30-day schedule sums exactly.** The generator produces 29 days at 4,767 and a final day of **4,757**, totalling **143,000**. The ten-shilling rounding is absorbed on the last day; the tenant is never billed a shilling more than he owes.

**Weekly equivalent:** 4,767 × 7 = **33,369** per instalment.

---

## Section 2 — How the tests were run

Every cell ran through the real production path: `agent_allocate_tenant_payment` → `agent_allocate_tenant_payment_internal` → `create_ledger_transaction` → `rent_apply_collections_to_days`, then read back through `v_rent_day_ledger`, `v_rent_plan_arrears`, `v_rent_collection_unapplied` and `agent_expected_collection`. No stubs, no fake passes.

**Three fixtures were needed, all reverted by the rollback:**

| Fixture | Why |
| --- | --- |
| `set_config('request.jwt.claims', …)` as the agent | `auth.uid()` is null on a direct connection; this is the same mechanism the API uses, and every authorization check still ran |
| `rent_arrears_go_live()` moved back | **This is the "move time ahead"**. `now()` cannot be changed, so instead the arrears window was widened backwards, which makes his prior days in-scope and overdue — the same effect as the clock advancing |
| Plan reshaped per scenario (`repayment_starts_on`, `amount_repaid`, `status`, `repayment_frequency`) and days re-pinned from `rent_plan_schedule_days` | To place one real plan into each of the nine states in turn |

His **money terms were never altered** — rent, fees, total and daily repayment stayed at their real values throughout.

**Verified after every run:**

| Check | Result |
| --- | --- |
| `rent_arrears_go_live()` | 2026-09-10 (unchanged) |
| Plan status / frequency / start date | repaying / daily / 2026-09-09 |
| Total / repaid / outstanding | 143,000 / 55,000 / 88,000 |
| His collections | 2, totalling 55,000 |
| Pinned days | 09-09 and 09-10, 4,767 each |
| Settlement rows | 0 |
| **Agent float** | **195,300 — unchanged** |
| Test ledger rows leaked | **0** |

---

## Section 3 — One day behind (T1)

Days pinned: **09-09** (open) and **09-10** (today), 4,767 each.

| Pay | Settled | Behind | Arrears | Due today | Stamped exp / short / partial | Held ahead |
| ---: | --- | ---: | ---: | ---: | --- | ---: |
| 5,000 | 09-09: 4,767 · 09-10: 233 | 0 | 0 | 4,534 | 4,767 / 0 / no | 0 |
| 4,767 | 09-09: 4,767 | 0 | 0 | **4,767** | 4,767 / 0 / **no** | 0 |
| 0 | — | 1 | 4,767 | 4,767 | — | 0 |
| 4,000 | 09-09: 4,000 | 1 | 767 | 4,767 | 4,767 / 767 / yes | 0 |
| 50,000 | 09-09: 4,767 · 09-10: 4,767 | 0 | 0 | 0 | 4,767 / 0 / no | **40,466** |

**What happens.** The oldest open day is taken first. On 5,000, yesterday absorbs 4,767 and only the leftover 233 reaches today — so today is still 4,534 short even though the agent collected more than a day's rent.

**The 4,767 row is the one to notice.** The agent collects exactly one day's money, the receipt says "no shortfall, not partial", and **today receives nothing at all**. That is the rule working correctly, but the receipt does not say so (Section 9, D1).

---

## Section 4 — Up to date, no arrears (T2 and T7)

These two scenarios describe the same condition — every day before today fully settled — so they are reported once. Yesterday was settled with a real 4,767 collection before each cell.

| Pay | Settled | Behind | Arrears | Due today | Stamped | Held ahead |
| ---: | --- | ---: | ---: | ---: | --- | ---: |
| 5,000 | 09-09: 4,767 · 09-10: 4,767 | 0 | 0 | 0 | 4,767 / 0 / no | 233 |
| 4,767 | 09-09: 4,767 · 09-10: 4,767 | 0 | 0 | 0 | 4,767 / 0 / no | 0 |
| 0 | 09-09: 4,767 | 0 | 0 | 4,767 | — | 0 |
| 4,000 | 09-09: 4,767 · 09-10: 4,000 | 0 | 0 | **767** | 4,767 / 767 / yes | 0 |
| 50,000 | 09-09: 4,767 · 09-10: 4,767 | 0 | 0 | 0 | 4,767 / 0 / no | **45,233** |

This is the clean case: with nothing owing behind, the whole payment lands on today and the receipt's shortfall matches reality exactly. Paying 4,000 leaves today 767 short and says so.

---

## Section 5 — Never paid (T3) and five days missed (T4)

**T3 — never paid, four days pinned (09-07 → 09-10):**

| Pay | Settled | Behind | Arrears | Stamped | Held ahead |
| ---: | --- | ---: | ---: | --- | ---: |
| 5,000 | 09-07: 4,767 · 09-08: 233 | 2 | 9,301 | 4,767 / 0 / no | 0 |
| 4,767 | 09-07: 4,767 | 2 | 9,534 | 4,767 / 0 / no | 0 |
| 0 | — | 3 | **14,301** | — | 0 |
| 4,000 | 09-07: 4,000 | 3 | 10,301 | 4,767 / 767 / yes | 0 |
| 50,000 | all four days at 4,767 | 0 | 0 | 4,767 / 0 / no | **30,932** |

**T4 — five days missed, six days pinned (09-05 → 09-10):**

| Pay | Settled | Behind | Arrears | Stamped | Held ahead |
| ---: | --- | ---: | ---: | --- | ---: |
| 5,000 | 09-05: 4,767 · 09-06: 233 | 4 | 18,835 | 4,767 / 0 / no | 0 |
| 4,767 | 09-05: 4,767 | 4 | 19,068 | 4,767 / 0 / **no** | 0 |
| 0 | — | 5 | **23,835** | — | 0 |
| 4,000 | 09-05: 4,000 | 5 | 19,835 | 4,767 / 767 / yes | 0 |
| 50,000 | all six days = 28,602 | 0 | 0 | 4,767 / 0 / no | **21,398** |

Every figure reconciles: 3 × 4,767 = 14,301; 5 × 4,767 = 23,835; 28,602 + 21,398 = 50,000.

**The 50,000 row is the recovery case.** One payment clears five missed days *and* today, and banks 21,398 against days still to come. **The 4,767 row is the fairness case** — a full day's money collected, no shortfall recorded, and the tenant still four days and 19,068 behind.

---

## Section 6 — Paying ahead

Confirmed working in every scenario. Surplus beyond all open days is never lost and never double-counted.

| Scenario | Paid | Landed on days | Held ahead |
| --- | ---: | ---: | ---: |
| T1 | 50,000 | 9,534 | 40,466 |
| T2 | 50,000 | 4,767 | 45,233 |
| T2 | 5,000 | 4,767 | 233 |
| T3 | 50,000 | 19,068 | 30,932 |
| T4 | 50,000 | 28,602 | 21,398 |

**Landed + held = paid, exactly, in every row.**

Money is held rather than applied because a settlement can only point at a day that has actually been billed — the composite foreign key to `agent_expected_day_plans` makes anything else impossible. Tomorrow does not exist yet at the moment of payment. The 00:10 EAT sweeper then lands held money on each new day as the 00:05 pin creates it.

---

## Section 7 — The three refusals and the expired cycle

**T5 — brand-new plan (approved today, repayment starts tomorrow).** Zero days pinned, `agent_expected_collection` returns **0**, and **all four positive amounts were refused** with `REPAYMENT_NOT_STARTED`. Correct: a plan funded today starts repaying tomorrow.

**T6 — completed / zero outstanding.** Zero days pinned, expected 0, and **all four positive amounts refused** with `AMOUNT_EXCEEDS_OUTSTANDING`. The system will not accept money against a settled plan.

**T8 — cycle expired (started 40 days ago, term ended 11 days ago).** 30 days pinned, **none of them today**:

| Pay | Settled | Behind | Arrears | Expected today |
| ---: | --- | ---: | ---: | ---: |
| 5,000 | 08-01: 4,767 · 08-02: 233 | 29 | 138,000 | **0** |
| 4,767 | 08-01: 4,767 | 29 | 138,233 | **0** |
| 0 | — | 30 | **143,000** | **0** |
| 4,000 | 08-01: 4,000 | 30 | 139,000 | **0** |
| 50,000 | 11 days, 08-01 → 08-11, sum 50,000 | 20 | 93,000 | **0** |

Two things this proves. **Arrears recovery on a dead cycle now has somewhere to land** — the 50,000 walked eleven days of history (ten full days plus 2,330 on the eleventh) and the total is exact. And **expected today is 0 on every row** while the tenant owes the entire 143,000 (Section 9, D2).

---

## Section 8 — Weekly repayment (T9)

Frequency switched to weekly, plan started 7 days ago. Days pinned: **09-03** and **09-10**, at **33,369** each — the weekly instalment, on due days only, never spread across the week.

| Pay | Settled | Behind | Arrears | Due today | Stamped exp / short / partial |
| ---: | --- | ---: | ---: | ---: | --- |
| 5,000 | 09-03: 5,000 | 1 | 28,369 | 33,369 | 33,369 / 28,369 / yes |
| 4,767 | 09-03: 4,767 | 1 | 28,602 | 33,369 | 33,369 / 28,602 / yes |
| 0 | — | 1 | 33,369 | 33,369 | — |
| 4,000 | 09-03: 4,000 | 1 | 29,369 | 33,369 | 33,369 / 29,369 / yes |
| 50,000 | 09-03: 33,369 · 09-10: 16,631 | 0 | 0 | **16,738** | 33,369 / 0 / no |

The weekly rule holds: **the expected figure is the full 33,369 instalment**, not a seventh of it, and it appears only on the collection day. The 50,000 splits exactly — 33,369 + 16,631 — leaving today 16,738 short.

---

## Section 9 — Defects, gaps and loopholes

Nothing was fixed. Each is reported for a decision.

### D1 — 🟠 A receipt can say "paid in full" while the tenant is days behind

`is_partial` and `shortfall_amount` are measured against **today's** scheduled amount only, ignoring everything owed behind it.

| Scenario | Paid | Shortfall recorded | `is_partial` | Reality after the payment |
| --- | ---: | ---: | --- | --- |
| T1 one day behind | 4,767 | 0 | **false** | today got **nothing** |
| T4 five days behind | 4,767 | 0 | **false** | **4 days / 19,068** still behind |
| T8 expired cycle | 4,767 | 0 | **false** | **29 days / 138,233** still owed |

Operations' partial-collection reporting will under-count. This is a reporting fault, not a money fault — the ledger and settlements are correct.

### D2 — 🟠 An expired cycle contributes 0 to today's expected while owing everything

T8 with no payment: 30 days behind, **143,000** owed, `agent_expected_collection` = **0**. Any recovery on such a plan scores nothing against the daily bill. The arrears queue now makes the debt *visible*; whether it should *count* is the open Phase 3 gate question.

### D3 — 🟠 NEW: moving the go-live floor backwards pulls historical payments into the queue

Found during this test, and it matters for any future backfill discussion.

The first T3 run put the floor at 09-07. His **real 55,000 from 8 September** immediately became "unapplied money" in scope, and the allocator spent it settling four days — so a 5,000 payment appeared to settle 19,068. The engine was behaving correctly; the *window* had been widened underneath it.

**Consequence:** the go-live floor is not merely a display filter. Lowering it activates every collection after the new floor and lets the allocator apply them. Anyone proposing to backfill arrears must expect historical payments to be swept into day settlements automatically. The test was re-run with his history cleared to get a true "never paid" state.

### D4 — 🟠 Two collections on one plan in one transaction still lose the balance

The known defect from 9 September, re-confirmed and it shaped this test's method. Where a scenario needed a pre-payment plus a test payment in the same transaction, `amount_repaid` did not advance for the second — the trusted-allocation guard compares the float debit to the balance delta across the whole transaction and silently reverts. Settlements and arrears are unaffected because they derive from `agent_collections`, so all figures in this report remain valid. Unreachable through the app, which uses one transaction per collection.

### D5 — 🔵 Day one of a plan is never collectable

T5 confirms a plan approved today has **zero pinned days** and refuses all collection. Intended behaviour — repayment starts the next day — but worth stating plainly so nobody reports it as a fault.

---

## Section 10 — Traceability, and what is confirmed working

### Who can see these repayments

Tested by impersonating a real holder of each role and calling the read functions against this plan:

| Role | `rent_plan_day_ledger` | `agent_arrears_overview` | `agent_collect_context` |
| --- | --- | --- | --- |
| CFO | ✅ | ✅ | ✅ |
| Agent Ops | ✅ | ✅ | ✅ |
| Tenant Ops | ✅ | ✅ | ✅ |
| Financial Ops | ✅ | ✅ | ✅ |
| The agent himself | ✅ | ✅ | ✅ |

No new dashboard component is required. Every settlement row names both the collection that paid and the day it settled, so money is traceable in either direction — from a receipt to the days it closed, or from an open day back to the payments against it. The chain runs `general_ledger` → `agent_collections` (with `tracking_id`) → `rent_day_settlements` → `agent_expected_day_plans`.

### Confirmed working

- **Oldest-day-first allocation** — exact in all 45 cells; settled + held-ahead always equals the amount paid
- **The 30-day cycle sums to exactly 143,000**, last day 4,757
- **Weekly plans** billed at the full 33,369 on due days only
- **Partial payments** accepted, never blocked, and correctly leave the day open
- **Pre-payment** held safely and never double-counted
- **Guards**: repayment cannot start early; a settled plan refuses more money
- **A settlement cannot exist against an unbilled day** — enforced by the composite foreign key
- **Full staff traceability** with no new UI

### Coverage

**45 of 45 cells measured** — every payment amount against every tenant state, on the live plan with the agent's real float. No cell was skipped, estimated or inferred.
