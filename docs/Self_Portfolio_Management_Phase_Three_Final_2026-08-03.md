# Self Portfolio Management — Phase Three (Final)
## The agreed rules, how the return is calculated, and how it reaches the partner's spendable wallet
**Date:** 2026-08-03  •  **Status:** FINAL — decisions closed, ready to build against.
**Supersedes:** the open questions in Phase Two §7. Everything here is now settled.
**Audience:** product, finance, operations, compliance. Plain language only.

---

## 0. What this document closes

Phase One asked whether a partner could fund a tenant directly. Phase Two fixed the calendar and
the timing. This document answers the eight open decisions and, most importantly, writes down
**exactly how the return is worked out and exactly how it lands as spendable money**.

Nothing in this document changes the managed product. Self-managed is the same financial promise
with a different way of choosing where the money goes.

---

## 1. The five decisions, now settled

| # | Question from Phase Two | **Final answer** |
|---|---|---|
| 1 | Who absorbs a tenant default? | **Welile — the company. Never the partner.** |
| 4 | Automatic redeployment on by default? | **Yes — but redeployment is into the queue, not back to the same tenant.** See §3. |
| 6 | Minimum commitment amount | **No fixed minimum. The partner's own spendable wallet balance is the limit.** See §4. |
| 7 | Same return as the managed route? | **Yes. Identical rate, identical schedule, identical wallet destination.** See §5. |
| — | Does tenant lateness reduce the partner's return? | **No. Never. The company carries the timing.** See §2. |

---

## 2. The partner is insulated from the tenant — completely

This is the heart of the product and it must be stated without hedging.

> **A partner who commits money earns their return on the money they committed, on the dates
> promised, regardless of what any individual tenant does.**

What that means in the three cases that actually happen:

| What the tenant does | What the partner sees |
|---|---|
| Pays on time, every day | Return paid on the monthly date. |
| **Pays late, or misses days** | **Return paid on the monthly date, in full, unchanged.** |
| **Stops paying entirely (defaults)** | **Return paid on the monthly date, in full. The committed capital is not written down. Welile absorbs the loss and pursues recovery through the existing collection and trust-score process.** |
| Finishes early | Return paid in full for the month already running; capital rolls to the next plan. |

Why the company carries this, and not the partner:

- The partner did not underwrite the tenant. **We** approved the tenant, verified the house,
  confirmed the landlord and priced the plan. The party that does the checking is the party that
  carries the consequence of the checking being wrong.
- It matches what we already tell managed partners. If self-managed partners could lose capital
  and managed ones could not, we would be selling a worse product to the partners who engage
  more — and they would leave.
- It is the same reasoning already accepted in the Welile Vouch Network, where Welile guarantees
  the borrower and recovers from the wallet and the trust score afterwards.

**The honest consequence, stated plainly:** tenant default is now a company cost line, not a
partner cost line. It must be budgeted and watched. Choosing to let a partner select the tenant
does **not** transfer the risk to them — selection is a convenience and a preference feature, not
an underwriting decision.

---

## 3. Automatic redeployment — the concern answered

The Phase Two recommendation was "automatic redeployment on by default", and the fair objection
raised was: **"what if the tenant doesn't come back?"**

The objection dissolves once one thing is clear:

> **Redeployment sends the money to the front of the funding queue — to whichever approved plan
> is waiting next. It does not wait for, or depend on, the tenant who just finished.**

So:

- Tenant finishes and posts a new plan → the partner gets first refusal for 24 hours (§6 of Phase
  Two), and if they take it, the money simply continues.
- **Tenant never comes back** → nothing stalls. The money goes to the next approved plan in the
  queue, which is somebody else entirely. The partner does not notice, and does not need to.

The partner's promise was never "this tenant". It was "this amount of money, at work, for this
term". A tenant leaving is not an interruption to that promise.

**Kept as designed:** automatic is the default, and a partner may switch to manual selection each
cycle. If they choose manual and do not act, their money sits idle and the paid-idle allowance in
Phase Two §5A applies — capped, and they are told plainly.

---

## 4. How much a partner may commit — the wallet is the limit

No arbitrary floor. The rule is a simple comparison the partner can see and understand.

> **A partner may commit up to their spendable (withdrawable) wallet balance. Not a shilling more.**

How it behaves on screen while they select tenants:

1. The partner's spendable balance is shown at the top and stays visible.
2. As each tenant is ticked, that plan's funding amount is added to a running total.
3. The running total is compared against the spendable balance on every tick.
4. If the total goes over, the confirm button is disabled and the message is explicit:

   > *"Selected plans total UGX 4,200,000. Your wallet has UGX 3,500,000 available. You are
   > UGX 700,000 over — remove a tenant or top up your wallet."*

Two rules that must not be relaxed:

- **The comparison uses the strict spendable balance** — the same figure the withdrawal screen
  uses, already net of pending holds and existing commitments. Not the headline wallet number, and
  not a cached figure. A partner must never be able to commit money that is already committed,
  already being withdrawn, or that is company float rather than theirs.
- **The check is re-run at the moment of confirming**, not only while selecting. A partner may sit
  on the screen for ten minutes while a withdrawal of theirs clears elsewhere. The balance at
  confirmation time is the one that counts.

---

## 5. The return: identical to the managed route

### 5.1 The rate

> **Self-managed uses exactly the same monthly rate as the managed product. The partner's existing
> agreed rate carries over unchanged.**

Today that is a flat monthly percentage of the principal, set per partner — live portfolios sit at
**15%** (the large majority), **20%**, and a small number at 10%. Whatever a partner's agreed rate
is on the managed route, that same rate applies when they select tenants themselves.

There is **no premium for self-selecting and no discount**. The partner does more work choosing;
they do not take more risk (§2), so they are not paid more. Equally, we do not pay them less for
saving us the allocation effort. Same money, same promise, both routes. This also removes any
incentive to game the two products against each other.

### 5.2 What the return is calculated on

**On the committed principal — not on the tenant's rent, not on what the tenant actually paid.**

This follows directly from §2. If the calculation touched what the tenant paid, then a late tenant
would reduce the partner's return, which is exactly what we have ruled out.

### 5.3 The monthly calculation

```text
Monthly return  =  committed principal  x  agreed monthly rate
```

Worked example, at the most common rate:

| Item | Figure |
|---|---|
| Partner commits | UGX 3,000,000 |
| Agreed monthly rate | 15% |
| **Monthly return** | **UGX 450,000** |
| Paid on | the same calendar date each month |

The principal is not reduced by any tenant's behaviour, so this figure is stable for the whole
commitment term.

### 5.4 The dates — the same-date rule from Phase Two

- The clock starts on the **day the landlord is paid**, not the day the partner clicked.
- Returns fall on the **same calendar date each following month**; where that date does not exist,
  the last day of the month is used.
- **Twelve returns in a twelve-month term.** Not 12.17. The 30-day shortcut is not used.

Example — landlord paid 31 January:

| Return | Date |
|---|---|
| 1st | 28 February |
| 2nd | 31 March |
| 3rd | 30 April |
| … | … |
| 12th | 31 January (following year) |

### 5.5 Showing daily and weekly — because most tenants pay daily

Partners will ask "what am I earning a day?", and the tenant selection screen must show plan
cadence anyway. Both are display figures derived from the one monthly number. **The payout itself
stays monthly**, exactly as on the managed route.

```text
Daily equivalent   =  monthly return  /  actual days in that calendar month
Weekly equivalent  =  daily equivalent  x  7
```

Using the UGX 450,000 example:

| Month | Days | Daily equivalent | Weekly equivalent |
|---|---|---|---|
| February | 28 | UGX 16,071 | UGX 112,500 |
| April | 30 | UGX 15,000 | UGX 105,000 |
| July | 31 | UGX 14,516 | UGX 101,613 |

Note the monthly total is UGX 450,000 in all three cases. Only the cosmetic daily figure moves —
the same principle Phase Two applied to the tenant's daily amount: **the total is sacred, the daily
figure flexes.**

Every screen showing a daily or weekly figure must label it as an equivalent, e.g.
*"≈ UGX 15,000 a day — paid monthly on the 14th"*. It must never look like a daily payout, or
partners will expect daily money and we will have created a support problem.

### 5.6 Plan cadence must be visible when selecting tenants

Because tenants repay on different rhythms, each tenant card in the selection list shows:

| Field on the card | Example |
|---|---|
| Repayment cadence | **Daily** / **Weekly** / **Other** |
| Plan length in days | 30 days |
| Exact end date (same-date rule) | ends 14 September 2026 |
| Amount to fund | UGX 700,000 |
| Tenant's repayment amount per cadence | UGX 23,333 daily |

Cadence is shown for judgement and transparency only. It changes **nothing** about the partner's
return — a weekly-paying tenant and a daily-paying tenant produce the identical monthly figure for
the partner, because the return is on committed principal (§5.2). This must be stated on the screen
so no partner believes daily-paying tenants pay them more.

---

## 6. How the return arrives in the spendable wallet

The route is the existing, proven managed-route path. Nothing new is invented.

### Step 1 — The return is recognised as owed
On the return date the amount is formally recorded as a company expense and a liability to the
partner **before any money moves**. A return that has not been recognised cannot be paid. This
accrual step is mandatory and already enforced on the managed route.

### Step 2 — It is posted as spendable, not committed
The return is credited to the partner as **spendable money**, tagged as a return credit. The
committed principal is untouched and stays locked for the term.

> **Returns are always withdrawable. The principal is not, until the term ends.**

### Step 3 — It lands in the withdrawable bucket, by construction
The credit is marked as going to a **person**, not to a company operating account. That single
marking is what puts it in the partner's spendable bucket rather than company float — the platform
already routes strictly on that basis, so a return can never silently land in a bucket the partner
cannot withdraw from.

### Step 4 — Managed-proxy partners are respected
Where a partner is served through a managed proxy agent, the credit follows the existing routing to
that proxy's wallet, and the partner's notification names the agent. Self-managed changes nothing
here.

### Step 5 — The partner sees it and can withdraw it
It appears in the partner's spendable balance and in their transaction history, and is withdrawable
under the normal withdrawal rules and limits — the same rules as any other return.

### Step 6 — The upcoming-payout view and the self-managed badge
Before the date arrives, the return appears in the partner's **upcoming payouts** view with its
date and amount. Each entry carries a clear **"Self-managed"** badge so a partner running both
products can tell at a glance which pot a return came from. When a tenant's plan completes, that
completion is reflected in the same view, badged the same way, so the partner can see their capital
has recycled without having to ask anyone.

Nothing about this changes the tenant or the landlord experience. The tenant pays their agent, the
agent's target and commission are untouched, and the landlord received their money at funding time.

---

## 7. The complete money story, end to end

```text
Partner wallet (spendable)
        |
        |  commits — capped by spendable balance (§4)
        v
Committed capital  ---- locked for the term ---->  freed at term end
        |
        |  funds an approved plan awaiting money
        v
Landlord is paid  ---- both clocks start here (§5.4)
        |
        |  tenant repays their agent, daily or weekly
        |  (late or defaulting changes NOTHING above this line — §2)
        v
Monthly return = principal x agreed rate (§5.3)
        |
        |  recognised as owed, then credited as spendable
        v
Partner wallet (spendable)  --->  withdrawable immediately
        |
        |  plan completes; capital rolls to the next plan in the queue (§3)
        v
   ... repeats until the term ends
```

---

## 8. What must be true for this to be safe

Stated as commitments, because each is a place this design could be undermined in build:

1. **The return calculation never reads tenant payment data.** If it does, §2 is broken.
2. **The commitment check uses the strict spendable balance, and re-checks at confirmation.**
   Anything cached lets a partner commit money that is not there.
3. **Returns are credited as person-bound money.** Anything else strands them in a bucket the
   partner cannot withdraw from.
4. **The recognition step happens before the payment step, every time.** No return is paid that was
   not first recorded as owed.
5. **Default losses land on the company's books explicitly, and are reported.** Absorbing them
   silently would hide a growing cost until it is large.
6. **Daily and weekly figures are labelled as equivalents of a monthly payout**, never as payouts.

---

## 9. Still deliberately out of scope

- The partner's monthly and annual statement, line by line.
- Whether the tenant or landlord is told who funded them.
- Finance reporting views for committed, idle and at-risk capital.
- The recovery steps after a default, beyond "the company carries it".
- Whether managed partners may move capital across at term end.

---
*Design document only. No system behaviour, data or money has been changed by producing this.*
