# Self Portfolio Management — Phase Two
## The rules of the product, written in plain language
**Date:** 2026-08-03  •  **Status:** design for approval. Nothing has been built or changed.
**Audience:** product, finance, operations, compliance. No technical vocabulary is used anywhere in this document.

---

## 0. What Phase One left out

Phase One answered *"can a partner support a tenant directly, and can we stop them from
withdrawing money they have already committed?"* The answer was yes.

Three things were missing, and they are the whole subject of this document:

1. **A rent plan is normally a one-month plan.** By default a posted rent request runs for
   one month unless the agent deliberately sets a longer period. When the month is finished,
   the tenant (or their agent) can post the next one. Phase One quietly assumed a 12-month
   relationship. That assumption is wrong and has to be replaced.
2. **A "month" is not 30 days.** Our system today measures a plan in days, and almost every
   plan is written as 30 days — even in February (28) and in the 31-day months. Once real
   partner money is attached to a plan, that shortcut starts to cost or gain someone money.
3. **Nobody explained the hand-over.** A partner sees a list of tenants, picks some, and
   deploys money. What happens in the minutes and weeks after that? Where does the money go,
   who counts it, when does the tenant start paying, and how does that avoid colliding with
   what the agent is already collecting?

**What the live data says (as of today):**

| Observation | Figure |
|---|---|
| Rent plans written as 30 days | 1,310 of 1,397 (94%) |
| Longer plans (60 / 84 / 90 / 120 days) | 62 |
| Short plans (7 / 21 days) | 24 |
| Tenants who have taken **more than one** plan | 246 |
| Tenants who have taken 4 or more | 28 (one tenant has 13) |

So the repeat, one-month-at-a-time cycle is not an edge case. It is the normal shape of the
business, and the partner product must be built around it rather than against it.

---

## 1. The corrected mental model

Phase One imagined: *one partner → one tenant → twelve months.*

Reality is: *one partner → a pot of money → a queue of one-month rent plans, one after another,
possibly for different tenants.*

So we stop selling "a tenant" and start selling **a place in the funding queue**.

> **The partner commits capital for a fixed term. The capital is put to work on whichever
> one-month rent plans are ready for funding at the time. When a plan finishes, the same money
> rolls into the next plan. The partner's term is a separate clock from the tenant's plan.**

Two clocks, never mixed up:

| Clock | Length | Who it belongs to | What it controls |
|---|---|---|---|
| **Commitment clock** | Chosen by the partner (proposed: 6 or 12 months) | The partner | When the partner's money becomes theirs to withdraw again |
| **Plan clock** | One month by default, or whatever the agent set | The tenant | When the tenant finishes paying and a new plan can be posted |

This separation solves the problem instantly: a tenant finishing early or leaving does **not**
end the partner's commitment, and a partner's term ending does **not** cut a tenant's plan short.

---

## 2. Defining "one month" so that it is fair and never argued about

### 2.1 The problem in one sentence
If we call every month 30 days, a plan that starts on 1 February ends on 3 March — the tenant
has paid three extra days of rent that they do not owe. Start it on 1 January and it ends on
31 January — the landlord is a day short.

### 2.2 The rule we propose (the "same-date rule")

> **A month runs from a start date to the same date in the following month. If that date does
> not exist in the next month, the month ends on the last day of that month.**

Examples:

| Plan starts | Plan ends | Days in that plan |
|---|---|---|
| 15 January | 15 February | 31 |
| 31 January | 28 February | 28 |
| 1 February | 1 March | 28 |
| 15 April | 15 May | 30 |
| 31 May | 30 June | 30 |

This is the same rule a landlord, a bank and a tenant already use in their heads. It requires
no explanation, and it can never drift.

### 2.3 What this means for the daily amount

Today the daily amount is the rent divided by a fixed number of days. Under the same-date rule
the number of days changes slightly month to month, and we must choose which side absorbs it.

**Recommendation: the total is sacred, the daily amount flexes.**

- The tenant is told one number that never changes: *what they owe in total for this plan*.
- The daily suggested amount is simply that total divided by the real number of days in the plan.
- The plan is finished when the total is paid — not when the days run out.

Why this way round: the tenant's obligation is the rent, not a daily figure; the landlord's
receipt is the rent, not a daily figure; and the partner's return is calculated on the rent,
not on the days. Only a cosmetic daily suggestion moves, which is the harmless number.

In February the daily figure will be slightly higher, in a 31-day month slightly lower. Total
unchanged. Nobody gains or loses.

### 2.4 What this means for the partner's return

The partner's monthly return is earned **per completed plan month**, using the same-date rule
applied to the day the partner's money was actually deployed. Not "every 30 days".

So a partner who deploys on 31 January earns their first month's return on 28 February, their
second on 31 March, and so on — always the same calendar anchor. Twelve deployments, twelve
returns, one year. Under the 30-day shortcut a partner would receive 12.17 payments a year,
which is a real and unbudgeted cost to Welile.

### 2.5 Short and long plans
Plans are not always one month (we have 7-day, 21-day, 60-day and 120-day plans live). The rule
generalises:

- **Under one month:** the partner earns a proportion of the month, calculated on the actual
  days of the plan against the actual days of that calendar month.
- **More than one month:** it is treated as consecutive same-date months, and the final part
  month is proportioned in the same way.

One rule, no special cases, no rounding arguments.

### 2.6 Grace and lateness
A plan that is not fully paid by its end date does not silently extend the partner's clock.
Lateness is a tenant-and-agent matter and is handled by the existing collection process. The
partner's return for that month is still due, and the shortfall is carried by whoever the
default rule names — which is still the one blocking decision from Phase One (see §7).

---

## 3. Which tenants a partner is shown, and when

This is the second gap, and it is the more important one commercially.

### 3.1 The golden timing rule

> **A tenant becomes visible to partners only in the window between "approved for funding" and
> "money sent to the landlord". Never before, never after.**

Why that window and no other:

- **Before approval**, the tenant is still being checked — house verified, landlord confirmed,
  identity confirmed, plan priced. Showing an unchecked tenant to a partner is a compliance and
  reputational risk, and half of them never get approved (we currently reject 180 of 1,397).
- **After the money has gone to the landlord**, the funding need no longer exists. The tenant
  is already paying. Offering it to a partner would be selling something that has already been
  sold — that is exactly the double-funding conflict the request warns about.

So the partner is not browsing "tenants". The partner is browsing **rent plans that are approved
and still waiting for money**. When money arrives — from any source — the item disappears from
every partner's screen at once.

### 3.2 Why this cannot conflict with the agent's collections

The agent's job starts *after* the landlord has been paid. That is when the tenant begins paying
their plan. Since a partner can only fund a plan *before* the landlord is paid, the two never
overlap in time.

| Stage | Who is active | Can a partner deploy here? |
|---|---|---|
| Plan posted, under review | Operations | No |
| Approved, waiting for money | **Partner or Welile** | **Yes — this is the only window** |
| Money sent to landlord | Finance | No — window just closed |
| Tenant paying their plan | Agent collecting | No |
| Plan completed | — | No, but a **new** plan may be posted later |

The only thing that changes for the agent is a label: the agent can see that the plan they are
collecting on was funded by a named partner rather than by Welile. Nothing about their
collection target, commission, or daily figure changes. Their money still comes from the tenant,
and their commission still comes from Welile.

### 3.3 Making sure two partners cannot fund the same tenant

A short exclusive hold, exactly like a seat at a cinema:

1. Partner opens a plan and starts confirming → the plan is **held for that partner for a few
   minutes**, and vanishes from everyone else's list.
2. Partner confirms → the plan is theirs, permanently.
3. Partner abandons or the hold expires → the plan returns to the pool.

Without this hold, two partners clicking at the same moment both believe they funded the same
tenant and one of them has to be refunded and apologised to. With it, that is impossible.

### 3.4 What the partner actually sees on each card

Enough to make a judgement, never enough to identify or contact the tenant before commitment:

**Shown:** area/neighbourhood, house type and photos, monthly rent, plan length and its exact
end date under the same-date rule, expected return for that plan, the tenant's Welile trust
banding (not the raw score), whether the landlord and house are verified, and the tenant's
first name only.

**Not shown:** phone number, exact address, identity document details, or any means of
contacting the tenant directly. Contact stays with the agent. This protects the tenant, and it
protects Welile's position as the party in the middle.

### 3.5 How the list is ordered
Fairness first, because partners will notice and complain if it is not:

1. Plans that have waited longest are shown first — a tenant should never be stuck because
   their house is less photogenic.
2. A partner's stated preferences (area, rent range, plan length) filter the list, they do not
   reorder it.
3. No partner sees a "better" pool than another. One queue, filtered.

---

## 4. What happens after the partner deploys — step by step

### Step 1 — Commitment
The partner's available money is set aside. It stops being spendable immediately and the wallet
says so, in words, on the same screen: *"Committed to 3 tenants. Becomes available again on
14 August 2027."*

### Step 2 — Assignment
Each chosen plan is marked as funded by that partner and disappears from the public pool. The
plan's start date, end date and total are fixed at this moment and never move.

### Step 3 — Landlord payment
The money is released to the landlord through the normal, unchanged finance route. Nothing
about the landlord's experience changes — same amount, same channel, same confirmation.

### Step 4 — Tenant starts paying
The tenant's plan clock starts on the day the landlord is paid, not on the day the partner
clicked. This is the single most important detail in this whole document: **the partner's return
clock and the tenant's payment clock must both start from the landlord payment date**, otherwise
the partner earns for days in which no tenant was under obligation.

### Step 5 — Collection
Unchanged. Agent collects, tenant pays, the plan runs down.

### Step 6 — The partner's monthly return
Paid on each same-date monthly anniversary of the landlord payment. It lands in the partner's
spendable money, not in their committed money — returns are always withdrawable, the principal
is not.

### Step 7 — The plan finishes, the commitment does not
When a plan completes, the partner's capital is freed **inside their commitment** and
automatically goes back into the queue for the next approved plan. The partner keeps earning
continuously and is never asked to re-pick every month.

They may switch this off and choose manually each cycle — but the default must be automatic,
or the plan queue stalls every time a partner is asleep, travelling or offline.

### Step 8 — The commitment term ends
On the commitment's end date, once the last plan the money is sitting in has completed, the
capital becomes spendable again and the partner may withdraw it or re-commit it.

---

## 5. Rolling capital between plans — the one hard case

A rent plan is one month; a commitment is a year. So in a year the same money will be recycled
roughly twelve times. Three situations must have a written answer before build:

**A. The queue is empty when a plan finishes.**
The money is idle through no fault of the partner. Proposal: Welile pays the return anyway for
up to a defined number of idle days per year (proposed: 15). Beyond that, returns pause and the
partner is told plainly why. This is honest, it is capped, and it is a strong operational
incentive on us to keep the queue full.

**B. The next plan needs more or less money than the last one.**
Money is pooled, not padlocked to one house. A partner's commitment may sit across two houses
at once, or partly idle, whichever fits. What the partner is promised is a return on their
committed amount — not a specific house forever.

**C. A tenant leaves mid-plan.**
The plan closes early, any recovered amount returns to the partner's committed pool and is
redeployed. The partner's return for the month already started is still paid. Unrecovered
amounts fall to the default rule.

---

## 6. The tenant's next plan — who gets first refusal

When a tenant completes a plan and posts a new one, we propose the funding partner gets a
**short right of first refusal** (proposed: 24 hours) before the plan enters the open pool.

Why: continuity is genuinely valuable. The partner already knows the house, the tenant knows
the arrangement is stable, and the agent keeps one relationship instead of two. If the partner
declines or their term has ended, the plan enters the open queue normally with no delay beyond
the 24 hours.

---

## 7. Decisions still required before anything is built

| # | Decision | Why it blocks |
|---|---|---|
| 1 | **Who absorbs a tenant default on a partner-funded plan?** | Still the single biggest open item. Everything below is cosmetic by comparison. |
| 2 | Commitment term options — 6 and 12 months, or 12 only? | Determines the wallet lock wording and the return schedule |
| 3 | Idle-capital allowance (proposed 15 days a year, paid) | Direct cost line; must be budgeted |
| 4 | Automatic redeployment on by default? (strongly recommended yes) | If off by default, the funding queue stalls |
| 5 | Right of first refusal on the tenant's next plan — 24 hours? | Affects tenant funding speed |
| 6 | Minimum commitment amount | Determines how many partners qualify |
| 7 | Is the return the same as the managed route, given the partner does the selecting? | Pricing and fairness between the two partner products |
| 8 | Exclusive hold length while a partner confirms (proposed 10 minutes) | Too short frustrates, too long starves the queue |

---

## 8. What Phase Three should cover

Not written yet, and deliberately kept out of this document:

- The partner's statement: what a monthly and annual statement must show, line by line.
- The tenant's and landlord's view: what, if anything, they are told about who funded them.
- Operational reporting: how finance sees committed capital, idle capital and returns due.
- Defaults in practice: the actual recovery steps once decision 1 is answered.
- Migration: whether partners already on the managed route can move capital across at term end.

---

## 9. Summary of the corrections this document makes to Phase One

| Phase One said | Phase Two corrects it to |
|---|---|
| A partner funds a tenant for 12 months | A partner commits money for a term; the money funds a succession of one-month plans |
| A month is 30 days | A month runs from a date to the same date next month; short months are honoured |
| The daily amount is fixed | The plan total is fixed; the daily suggestion flexes with the real day count |
| Returns every 30 days | Returns on the same calendar date each month — 12 a year, not 12.17 |
| Partners browse tenants | Partners browse approved plans still awaiting money, and only in that window |
| (Silent on conflict with agents) | The partner window closes exactly where the agent's collection begins, so they cannot overlap |
| (Silent on double funding) | A short exclusive hold while a partner confirms |
| (Silent on what happens when a plan ends) | Capital automatically rolls into the next plan, with a capped paid-idle allowance |
| (Silent on repeat tenants) | The funding partner gets a short right of first refusal on the tenant's next plan |

---
*Design document only. No system behaviour, data or money has been changed by producing this.*