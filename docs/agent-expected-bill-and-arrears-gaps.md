# The daily bill, arrears, and what the expected figure does not see

**As at 2026-09-09 09:32 EAT.** Every figure below was re-derived from production
at that moment. Collections arrive continuously — re-run the queries in
[Appendix: verification queries](#appendix-verification-queries) before quoting
any of this. Nothing here is a baseline.

Related: `.claude/skills/welile-expected-vs-collected` (the bill vs the receipt
book, and the coverage trap).

---

## 1. Answer in one paragraph

`agent_expected_day_plans` is a **bill for one day only**. It holds one row per
plan per scheduled day, valued at that day's instalment, and it carries **no
memory of whether earlier days were paid**. Nothing rolls forward. There is no
arrears line, no "behind" balance, no catch-up. When a plan reaches the end of
its schedule it stops producing rows **permanently**, even if the tenant still
owes millions — so its later repayments can never be measured against any bill
and land forever as unscoreable "arrears".

---

## 2. What the bill is, precisely

| | Value |
| --- | ---: |
| Rows | one per `(day, rent_request_id)`, unique constraint |
| Value of a row | that day's instalment from `rent_plan_schedule_days` |
| Written by | cron `pin-agent-expected-day-eat-midnight`, `5 21 * * *` UTC = 00:05 EAT |
| Re-runnable? | no — `pin_agent_expected_day` short-circuits if the day has rows |
| Mutable? | no — an expectation once pinned never changes |

Pin health is good. Every day from 2026-06-11 to 2026-09-09 is pinned exactly
once, with a single `captured_at` at 21:05 UTC. No gaps, no double-runs.

**It does not accumulate.** If a tenant billed 178,000 on Monday pays nothing,
Tuesday's bill is still 178,000 — not 356,000. The unpaid Monday amount exists
nowhere in the bill after Monday.

### The consequence for measurement

Because the bill is per-day and the receipt book is not, dividing one total by
the other is wrong. Tenants pay off *older* bills every day, so the numerator
contains money the denominator never billed.

2026-09-08, network:

| Reading | Value |
| --- | ---: |
| Expected (pinned bill, 194 plans / 51 agents) | 3,673,184 |
| Collected **against that day's bill** | 1,599,261 → **43.5%** |
| Arrears collected (plans not billed that day) | 1,893,222 |
| **Total cash in** | **3,492,483** |
| Naive `cash ÷ bill` | **95.1%** ← wrong |
| Capped per tenant at what they owed | 1,149,701 → **31.3%** |
| Billed tenants who paid nothing | **115 of 194** |

`1,599,261 + 1,893,222 = 3,492,483` — the split is exact, so no cash is
unattributed.

Report four figures, never one ratio.

---

## 3. What happens when the cycle completes and arrears remain

This is the largest gap in the system.

`rent_plan_schedule_days` emits instalments only for days inside
`term_start … obligation_end`. Once that window closes the plan generates no
instalment, so the pin has nothing to write, so **the plan never appears on a
bill again — regardless of outstanding balance.**

Of 655 plans at `status = 'repaying'` with tenancy active:

| | Plans | Still owed |
| --- | ---: | ---: |
| On the 2026-09-08 bill | 175 | 89,500,450 |
| **Owing but never billed** | **476** | **149,009,581** |
| — of which past `obligation_end` | **427** | **129,137,935** |
| — absent from `v_rent_plan_schedule` | 41 | — |
| — term not started yet (correct) | 5 | — |
| — should have been billed | 3 | see §5 |

**62.5% of outstanding debt is invisible to every expected and coverage figure
in the product.** If those 476 plans were billed at their own `daily_repayment`,
the daily bill would be roughly **8,436,573 higher** — about 12.1M instead of
3.67M.

A worked example, one agent on 2026-09-08 (sir ian martin). Four of his plans
run `daily_repayment` 178,000 against `total_repayment` 5,340,000 — exactly a
30-day term, all 30 days billed, last billed 20–28 August, each still owing
1.0M–3.0M:

| Collected 2026-09-08 | Still owed | Last billed |
| ---: | ---: | --- |
| 300,000 | 2,957,917 | 2026-08-20 |
| 260,000 | 1,052,000 | 2026-08-20 |
| 170,000 | 1,909,712 | 2026-08-20 |
| 119,999 | 2,003,001 | 2026-08-20 |

His day read: expected 361,768 across 4 billed plans, total cash 1,030,000
across 9 receipts on 7 plans. Only **170,000** was against that day's bill; the
other **860,000 (83.5%)** was recovery on the plans above. Presented as a ratio
that is 285% attainment; his real coverage was **47.0%**, with 0 of 4 billed
tenants paying in full, 2 partial and 2 nothing.

That 860,000 is genuine, valuable arrears recovery. The system cannot credit it
against anything.

### The product decision

Either arrears generate an overdue line on the bill — so the 129M becomes
visible and agents can be measured on recovering it — or it stays permanently
unscoreable. This is not a code bug; it is a missing concept. Until it is
decided, **no coverage percentage in the product means "are tenants up to
date"** — every one of them means "did today's scheduled instalments get paid".

---

## 4. Repayment starts the day after funding — already implemented, not enforced

The rule is correct and already reflected in data. `repayment_starts_on` is
populated on **all 1,318** funded/repaying/completed plans; none are NULL:

| `repayment_starts_on − funded_date` | Plans | Note |
| ---: | ---: | --- |
| **+1** | **1,197** | the rule, correctly applied |
| 0 | 1 | outlier — see §5 |
| −4 … −14 | 9 | back-dated start; the pre-funding days never enter a bill, by design |

`v_rent_plan_schedule.term_start` is
`COALESCE(repayment_starts_on, funded_at::date)`. The fallback to the funding
day would break the rule, but with zero NULLs it is currently dead code. Leave
it alone or tighten it to `+ 1`; it changes nothing today.

### What is *not* enforced

**Nothing stops a collection before repayment starts.**
`agent_allocate_tenant_payment` — the RPC that writes every collection row —
does not reference `repayment_starts_on`, `term_start` or `funded_at` at all.
Neither does `agent_expected_collection` or `enforce_agent_daily_eligibility`.

It has already happened. Two ways to measure it, and the gap between them is
itself the broken plan:

| Basis | Collections | Plans | Value |
| --- | ---: | ---: | ---: |
| Landed **before `repayment_starts_on`** (what a guard would reject) | **29** | 24 | **1,098,567** |
| Landed **on the funding day** | 30 | 25 | 1,108,567 |

The extra row is `39976d4a` (§5): its `repayment_starts_on` *is* its funding day,
so a collection that day is on-funding-day but not before-start. Earliest
occurrence 2026-05-26, most recent 2026-09-08.

Those collections are structurally unscoreable: they land on a day the plan was
not billed, so they can only ever be counted as arrears.

### On locking the pay button + 24h countdown

Correct, and worth doing — with one caveat about what it fixes.

- **It closes the collection-side hole.** A server-side guard in
  `agent_allocate_tenant_payment` rejecting collections before
  `repayment_starts_on` is the real control; the frontend lock and countdown are
  the humane surface for it. The guard must be server-side, because the frontend
  is not the only caller and there is no guard today.
- **It does not improve the expected figure.** The 29 affected collections are
  worth 1.1M against a 129M arrears blind spot. Accuracy of "expected" is
  governed by §3, not by this.
- **It is enforcement, not introduction.** 1,197 of 1,318 plans already start at
  +1. The lock stops the remaining drift and makes the rule true by construction
  rather than by convention.

So: yes, do it — but bank it as *correctness of the collection record*, not as a
fix for the coverage numbers.

---

## 5. The one genuinely broken plan

`39976d4a-2c59-4349-a5db-0c5082852c22`

| Field | Value |
| --- | --- |
| `repayment_frequency` | `weekly` |
| `duration_days` | 7 |
| `funded_at` (EAT) | 2026-09-08 |
| `repayment_starts_on` | **2026-09-08** ← the only plan in the book at delta 0 |
| `total_repayment` | 1,747,223 |
| `amount_repaid` | 47,223 |
| Still owed | **1,700,000** |
| Instalments its schedule will ever produce | **one**, due 2026-09-08, 1,747,223 |
| Days ever billed | **0** |

Because `repayment_frequency = 'weekly'` and the term is 7 days,
`ceil(7 / 7) = 1` instalment, dated `term_start`. `term_start` is its own
funding day, and the 2026-09-08 pin ran at 00:05 EAT — hours before it was
funded. The schedule generates no other date, and the pin cannot re-run for a
pinned day, so **this plan can never be billed.**

Two earlier suspects are **not** bugs and must not be touched:
`52e40df6-…` and `f926b092-…` were funded 2026-09-08 with back-dated
`repayment_starts_on` (−13 and −14 days). Their pre-funding days correctly never
enter a bill, and both appear on the 2026-09-09 bill as expected.

### Options for the one plan

| Option | Effect | Cost |
| --- | --- | --- |
| **A. `repayment_starts_on` → 2026-09-10** | the 00:05 Sep 10 pin picks it up naturally | deviates from the +1 rule by one day; no pin touched, no history rewritten |
| **B. → 2026-09-09 + manual pin insert** | billed today | restates today's bill 5,258,095 → 7,005,318 (**+33.2%**); breaks pin immutability |
| **C. leave it** | 1,700,000 stays unscoreable arrears | consistent with the other 476 plans, but a known-wrong row |

**A is recommended.** It is a one-row data correction, rewrites nothing, and the
plan starts billing tomorrow.

Note either way: a `weekly` plan with a 7-day term bills as a **single balloon
instalment of the entire 1,747,223 on day one**, while the tenant is actually
paying in small amounts (47,223 so far). Whichever day it lands on, that day's
bill jumps by 1.75M. Worth confirming that is the intended shape for
`weekly` + `duration_days = 7`.

### Wider set

Instalments the schedule says fell due inside the pinned era (2026-06-11 →
2026-09-09) but were never pinned: **102 instalments across 13 plans, 3,320,828**.

| Frequency | Plans | Missed instalments | Value |
| --- | ---: | ---: | ---: |
| weekly | 2 | 2 | 1,864,104 |
| daily | 11 | 100 | 1,456,724 |

Only **10** of the 102 fall on the plan's funding day — those are the defect
class. The other **92 are back-dated pre-funding days**, which by design never
enter a bill and **must not be back-filled**.

Back-filling all 102 would restate already-reported days:

| Day | Pinned now | Would add | Change |
| --- | ---: | ---: | ---: |
| 2026-09-08 | 3,673,184 | +1,866,437 | **+50.8%** |
| 2026-09-02 | 3,899,166 | +212,927 | +5.5% |
| 2026-09-06 / 07 | 4,029,184 | +119,214 | +3.0% |
| 2026-09-04 / 05 | ~4.4M | +119,214 | +2.7% |
| 2026-09-03 | 5,000,890 | +103,030 | +2.1% |

Sep 8 coverage would drop **43.5% → 28.9%** on identical cash, and every agent's
attainment for those days would worsen retroactively. Not recommended.

---

## 6. Recommendations, in priority order

1. **Decide the arrears question (§3).** 129,137,935 across 427 plans is
   invisible to every expected figure. Everything else on this list is small by
   comparison.
2. **Add the server-side guard** in `agent_allocate_tenant_payment` rejecting
   collections before `repayment_starts_on`, then lock the button and show the
   countdown. Closes a real hole (29 collections, 1,098,567) with no server
   control today.
3. **Fix the one plan** via option A.
4. **Confirm the `weekly` + 7-day balloon shape** is intended.
5. **Do not back-fill** the 92 back-dated instalments, and do not re-pin any day.
6. **Investigate the 41 plans absent from `v_rent_plan_schedule`** that are
   repaying and owing — cause not yet established.

---

## Appendix: verification queries

Ready recipes live in
`.claude/skills/welile-expected-vs-collected/references/queries.md`. The two used
most here:

**Is the day's bill complete?**

```sql
select day, count(*) rows, sum(expected_ugx) expected,
       min(captured_at) first_pin, max(captured_at) last_pin
from agent_expected_day_plans
where day >= (now() at time zone 'Africa/Kampala')::date - 7
group by 1 order by 1 desc;
```

`first_pin = last_pin`, single timestamp near 21:05 UTC, is healthy.

**Debt the bill cannot see**

```sql
select count(*)                                     as plans,
       sum(greatest(coalesce(total_repayment,0)
                  - coalesce(amount_repaid,0),0))   as owed_invisible
from rent_requests rr
where rr.status = 'repaying'
  and coalesce(rr.tenancy_status,'active') <> 'ended'
  and greatest(coalesce(rr.total_repayment,0)
             - coalesce(rr.amount_repaid,0),0) > 0
  and not exists (select 1 from agent_expected_day_plans e
                    where e.rent_request_id = rr.id
                      and e.day = (now() at time zone 'Africa/Kampala')::date);
```

**Instalments the schedule generated but the pin never wrote**

```sql
with sched as (
  select d.rent_request_id, d.due_on, d.amount
  from rent_plan_schedule_days('2026-06-11', (now() at time zone 'Africa/Kampala')::date) d
)
select count(*) missed, count(distinct rent_request_id) plans, sum(amount) value
from sched s
where not exists (select 1 from agent_expected_day_plans e
                    where e.rent_request_id = s.rent_request_id and e.day = s.due_on);
```

**Collections that landed before repayment started**

```sql
select count(*) collections, count(distinct ac.rent_request_id) plans, sum(ac.amount) value
from agent_collections ac
join rent_requests rr on rr.id = ac.rent_request_id
where ac.amount > 0
  and (ac.created_at at time zone 'Africa/Kampala')::date < rr.repayment_starts_on;
```
