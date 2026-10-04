# Self Portfolio Management — Phase Four
## Staggered tenant dates, when the partner actually earns, how many tenants share one commitment, and why there is no compounding
**Date:** 2026-08-03  •  **Status:** FINAL — closes the three issues raised against Phase Three.
**Reads with:** Phase Three (Final). Nothing here contradicts it; this fills the gaps it left open.
**Audience:** product, finance, operations, compliance. Plain language only.

---

## 0. The three questions this document answers

1. A partner picks several tenants and those tenants start on **different dates**. When does the
   partner earn? Do we tell them "end of the month"? Does the system just pay automatically?
2. Is the return worked out on the **rent amount** or on the **repayment amount**?
3. A partner selects **5 tenants**. Does the money get distributed to each of them, or does it go to
   a landlord float in one lump?

And one standing instruction, restated so it cannot be lost:

> **Self-managed has no compounding. None. Ever.** See §5.

---

## 1. The unit of money is the funding line — not the commitment

This single idea makes every other answer obvious.

When a partner ticks 5 tenants and confirms, the system does **not** create one blob of money. It
creates **5 separate funding lines**, one per tenant:

```text
Partner commitment (UGX 3,500,000)
   |
   +-- Line 1  -> Tenant A  UGX 700,000
   +-- Line 2  -> Tenant B  UGX 700,000
   +-- Line 3  -> Tenant C  UGX 700,000
   +-- Line 4  -> Tenant D  UGX 700,000
   +-- Line 5  -> Tenant E  UGX 700,000
```

Each line has its own:

| Property of a line | Why it must be per line |
|---|---|
| Amount funded | Each plan needs a different amount. |
| Landlord paid, and the date they were paid | Landlords are different people, paid on different days. |
| Its own start date (the day **that** landlord was paid) | Phase Three §5.4 starts the clock at landlord payment. |
| Its own 12-month term and end date | Lines started weeks apart must not be forced to end together. |
| Its own earning status: **idle → funded → earning → completed** | One landlord being slow must not stall the other four. |

Everything below follows from this.

---

## 2. When does the partner earn, with tenants starting on different dates?

### 2.1 The rule

> **Each funding line starts earning on the day that line's landlord is paid.
> All earned amounts are then paid out together, once a month, on the partner's own payout date.**

Two separate things, and they must not be confused:

| Thing | Governed by |
|---|---|
| **When earning starts** | The tenant/landlord — specifically, the day that landlord is paid. Per line. |
| **When money is paid out** | The partner — one fixed monthly date for the whole portfolio. |

So the answer to "do we tell them end of the month?" is: **no — we tell them their own payout date,
and we show it before they confirm.**

### 2.2 The partner's payout date

> **The partner's payout date is the same calendar date each month, set by the day the partner's
> first funding line went live.** Where that date does not exist in a month, the last day of the
> month is used. This is the same-date rule already agreed in Phase Three §5.4, applied once at
> partner level instead of five times at tenant level.

Why one date and not five: a partner funding 5 tenants would otherwise receive 5 small payments on
5 unrelated dates every month, with 5 notifications and 5 lines to reconcile. That is a support
burden and it looks disorganised. One date, one payment, one clear statement.

### 2.3 Lines that start mid-cycle are paid pro-rata

A line that goes live 9 days before the payout date has not earned a full month. It earns for the
days it was actually live:

```text
First-cycle amount for a line
  = (line principal x agreed monthly rate) x (days live in that cycle / days in that cycle)
```

After the first cycle, that line earns the full monthly amount like every other line.

**Worked example** — partner rate 15%, payout date the 14th of each month:

| Line | Amount | Landlord paid | Days live to 14 Aug (31-day cycle) | Earned in the first payout |
|---|---|---|---|---|
| 1 | 700,000 | 14 Jul | 31 | 105,000 |
| 2 | 700,000 | 20 Jul | 25 | 84,677 |
| 3 | 700,000 | 29 Jul | 16 | 54,194 |
| 4 | 700,000 | 5 Aug | 9 | 30,484 |
| 5 | 700,000 | Not yet paid | 0 | 0 — see §2.5 |
| | | | **First payout (14 Aug)** | **UGX 274,355** |

From the 14 September payout onward, lines 1–4 each earn the full 105,000 → **UGX 420,000**, and
line 5 joins with its own pro-rata slice the month its landlord is paid.

This is the honest answer to the staggering problem: **the partner is never paid for days their
money was not working, and never short-paid for days it was.**

### 2.4 Is it automatic?

> **Yes. The partner selects and funds. Nothing else is ever required of them.**

On the payout date the system, without any human action:

1. Works out each live line's earned amount for the cycle (full month, or pro-rata if it started
   mid-cycle, or pro-rata if it completed mid-cycle).
2. Adds them into one figure.
3. Records the amount as owed to the partner **before paying it** (Phase Three §6 Step 1).
4. Credits it to the partner as **spendable** money (Phase Three §6 Steps 2–3).
5. Sends one notification naming the amount and the number of lines it covers.

No approval queue, no request, no "claim your returns" button. A return the partner has to ask for
is a return we will be asked about.

### 2.5 What the partner is told, before they confirm

The confirmation screen must state all four of these plainly:

- **"Each tenant starts earning on the day we pay that tenant's landlord — not today."**
- **"You will be paid once a month, on the 14th."**
- **"Your first payment covers only the days each tenant was actually live, so it will be smaller
  than a full month."**
- **"Your full monthly amount from then on: UGX 525,000."**

Setting this expectation up front is what stops the first payout looking like an underpayment. A
partner who is surprised by a correct number will report it as a fault.

---

## 3. Rent amount, or repayment amount? Neither.

> **The return is calculated on the principal the partner committed. Not the rent. Not the
> repayment. Not what the tenant actually paid.**

| Candidate base | Verdict | Why |
|---|---|---|
| Tenant's **rent** amount | **No** | Rent is the landlord's figure. It may differ from what we funded (deposits, arrears, part-funding), so it would pay partners for money they never put in. |
| Tenant's **repayment** amount | **No** | Repayment includes our fee, and it moves with cadence and duration. It would also make a late or defaulting tenant reduce the partner's return — which Phase Three §2 rules out absolutely. |
| **Committed principal** | **Yes** | It is the money the partner actually risked, it is knowable at commitment time, and it is completely insulated from tenant behaviour. |

```text
Line monthly return  =  line principal  x  agreed monthly rate
Partner monthly payout  =  sum of all live lines' amounts for that cycle
```

Consequence to accept openly: on a plan where the tenant's repayment happens to be smaller than the
return we owe, that gap is a **company cost**, exactly like a default (Phase Three §2). Pricing the
plans is our job, not the partner's.

---

## 4. Five tenants: distributed per tenant, never a lump into float

> **The money is split per tenant and each portion is paid to that tenant's own landlord. It is
> never pooled into a landlord float as one lump.**

What happens on confirm, per line, independently:

1. The line's amount is reserved out of the partner's spendable wallet and marked committed.
2. The line is attached to one specific approved plan — one tenant, one house, one landlord.
3. When that landlord is paid, **that line only** flips to earning, on that date.
4. Lines whose landlords are not yet paid stay **idle** and earn nothing yet (§2.3, line 5).

Why pooling is not acceptable:

| Problem with one lump into float | Consequence |
|---|---|
| No line-level start date | The staggered-date maths in §2.3 becomes impossible — we could not tell what earned when. |
| Partner money mixed with company float | Breaks the platform's bucket rules: partner money is person-bound, float is company money. |
| No traceability | We could not tell a partner which of their tenants their capital is in, or show completion per tenant. |
| Recycling breaks | Phase Three §3 recycles capital **per completed plan**. A pool has nothing to recycle. |

**Partial funding must be handled honestly.** If a line's amount is short of what the plan needs, the
plan waits, or another funder tops it up and each funder holds their own line on the same plan. What
must never happen is a partner's money being spent on a plan they did not select, or sitting
undisclosed in a company account.

**Per-tenant visibility the partner gets:**

| Tenant | Funded | Status | Started | Earning |
|---|---|---|---|---|
| Tenant A | 700,000 | Earning | 14 Jul 2026 | 105,000 / month |
| Tenant D | 700,000 | Earning | 5 Aug 2026 | 105,000 / month |
| Tenant E | 700,000 | Awaiting landlord payment | — | starts when landlord is paid |

---

## 5. No compounding — stated as a hard rule

> **Returns are never added to principal. A return paid is a return finished.**

Concretely, in self-managed:

1. **Principal is fixed for the term.** UGX 700,000 committed earns on 700,000 in month 1 and on
   700,000 in month 12.
2. **A paid return never becomes principal.** It lands as spendable money and stops being part of
   the calculation the moment it is credited.
3. **An unwithdrawn return does not grow.** If a partner leaves returns sitting in their wallet,
   they sit. There is no growth allowance, no daily accrual, no interest-on-interest of any kind on
   self-managed capital.
4. **Re-investing is a deliberate new act.** A partner may of course commit their returns to a new
   tenant — but that is a **new funding line, chosen by them, with its own start date and its own
   term**. It is never automatic and never silent.
5. **Recycling is not compounding.** When a plan completes and the same principal funds the next
   plan (Phase Three §3), the amount at work is unchanged. Recycling moves principal; compounding
   would grow it. Only the first is allowed.

Everything in self-managed is therefore **simple monthly return on a fixed principal** — the same
shape as the managed product, and nothing more.

---

## 6. The complete picture, with staggered dates

```text
Confirm (1 Jul)         5 lines created, 5 amounts reserved
   |
   |--- Line 1: landlord paid 14 Jul  -> earning from 14 Jul
   |--- Line 2: landlord paid 20 Jul  -> earning from 20 Jul
   |--- Line 3: landlord paid 29 Jul  -> earning from 29 Jul
   |--- Line 4: landlord paid  5 Aug  -> earning from  5 Aug
   |--- Line 5: landlord not paid yet -> idle, earns nothing
   |
   v
Partner payout date = 14th of every month (set by the first line going live)
   |
   |  each cycle: full month per line, pro-rata for its first and last cycle
   |  recognised as owed, then credited as spendable, automatically
   v
Partner spendable wallet  ->  withdrawable immediately, never compounded
```

---

## 7. What must be true for this to hold

1. **A commitment is stored as separate per-tenant lines, each with its own funded date.** Without
   this, staggered starts cannot be paid correctly.
2. **A line earns nothing until its own landlord is actually paid.** Not on confirm, not on approval.
3. **The payout is one monthly partner-level payment, pro-rata in first and last cycles.**
4. **The base is committed principal only.** The calculation must never read rent or repayment data.
5. **Partner money is never pooled into company float, not even briefly.**
6. **No process anywhere adds a paid return back into principal, and idle returns never grow.**
7. **The pro-rata explanation is shown before confirmation, not after the first small payout.**

---

## 8. Still out of scope

- The statement layout showing line-by-line pro-rata arithmetic to the partner.
- What happens to a line whose landlord is never paid beyond a reasonable window (idle-capital policy
  sits in Phase Two §5A).
- Whether two partners may co-fund a single plan as standard practice, rather than by exception.
- Term-end mechanics for taking principal out instead of recycling it.

---
*Design document only. No system behaviour, data or money has been changed by producing this.*
