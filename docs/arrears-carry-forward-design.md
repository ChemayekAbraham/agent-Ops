# Carry the shortfall forward: the agreed approach to partials and missed days

**Status: phase 1 built and applied 9 September 2026** — see
[`arrears-phase1-shipped.md`](./arrears-phase1-shipped.md). This records what the team decided,
how it maps onto the system as it actually stands today, and the decisions still
outstanding. No code or schema was changed to write this.

Figures re-derived from production on **9 September 2026**. Collections arrive
continuously — re-derive before quoting any of them.

Background: [`agent-expected-bill-and-arrears-gaps.md`](./agent-expected-bill-and-arrears-gaps.md),
and the `welile-expected-vs-collected` skill.

---

## 1. The decision

Instead of guarding against partial payments defensively, arrears become a
first-class, visible, collectable obligation.

### Rule 1 — a shortfall carries to the next repayment

A tenant due 4,500 who pays 4,000 leaves 500 short. That 500 is added to their
next repayment, so the next obligation is 4,500 + 500 = **5,000**. Partials are
still recorded individually.

### Rule 2 — missed days must be covered before the current one

An agent who missed yesterday's 10,000 and pays 10,000 today has that payment
applied to **yesterday's** obligation first. Today's remains outstanding. The
system must know which day a payment settles, not just that money arrived.

### The constraint on both

> It must not affect their daily target.

This is the load-bearing sentence, and it is what makes the design work rather
than becoming another way to punish agents.

---

## 2. What "must not affect the daily target" forces

Taken literally alongside Rule 1 there is a contradiction: if tomorrow's
obligation becomes 5,000, and the daily target is "what is due", then the target
*has* changed.

The reading that satisfies both rules is that **three different numbers exist**
and only one of them is the target:

| Number | Value in the worked example | What it is |
| --- | ---: | --- |
| **Daily target** | 4,500 | the scheduled instalment from the pinned bill. Unchanged by arrears. This is what the 50% eligibility gate measures. |
| **Amount to collect** | 5,000 | scheduled instalment + carried arrears. What the collection screen offers the agent. |
| **Arrears carried** | 500 | tracked separately, shown to the agent, credited when recovered. |

Keeping these apart is what stops the two rules from turning into a penalty
spiral. If the carry were folded into the target, a tenant short for a week
would push their agent's target far beyond anything collectable, and the agent
would be blocked from posting new Rent Plans for a shortfall that is not theirs.
We have already seen exactly that failure mode: an agent whose target ballooned
to 1.9M against a book that collects ~178,000/day would have needed ~963,000 in
one day to stay eligible.

It is also the only reading compatible with the pin, below.

---

## 3. The architectural constraint: the bill is immutable

`pin_agent_expected_day(day)` writes one row per plan per scheduled day at 00:05
EAT and **short-circuits if the day already has rows** — `if exists (rows for
that day) return 0`. An expectation, once pinned, never changes.

So Rule 1 **cannot be implemented by adding 500 to tomorrow's pinned row.** That
would mean mutating a frozen bill, which destroys the one property that makes
historical reporting trustworthy: that yesterday's expected figure still reads
today what it read yesterday.

The carry therefore has to be **a separate quantity** — its own ledger, or a
figure derived at read time from the shortfalls already recorded — layered on top
of the bill rather than written into it. Everything downstream (the collection
screen, the agent's arrears view, reports) reads bill + carry. The bill itself
stays untouched.

---

## 4. What already exists, and what does not

Better news than expected: roughly half the raw material is in place.

### Already there

**Per-receipt shortfall.** `agent_collections` carries `shortfall_amount`,
`is_partial` and `partial_reason`, stamped by `agent_allocate_tenant_payment` at
the moment of collection. This is Rule 1's tracking requirement, already
satisfied:

| | Receipts | Plans | Shortfall recorded |
| --- | ---: | ---: | ---: |
| **Total** | **795** | **288** | **12,874,625** |
| daily plans | 774 | 281 | 12,219,392 (94.9%) |
| weekly plans | 21 | 7 | 655,233 (5.1%) |

All of it falls inside the last 30 days, so the stamping is recent. **12,874,625
is the size of the carry pool** Rule 1 would formalise.

**The pinned daily bill.** `agent_expected_day_plans` already holds one
obligation per plan per scheduled day, keyed `(day, rent_request_id)`, written
once at 00:05 EAT and never altered. **That is Rule 2's queue of debts**, already
in place — what was missing was only the settlement side, which is what phase 1
added.

> **Correction.** An earlier version of this section named
> `instalment_allocations` and `post_instalment_waterfall()` as "essentially
> Rule 2's data model". That was wrong. `instalment_allocations` is a
> revenue-split ledger — its columns split an instalment into components such as
> `partner_reward_component`, which has nothing to do with which *day* a payment
> settles — and its unique index allows only one row per payment, so it cannot
> express one payment spread across several days. `post_instalment_waterfall()`
> is a waterfall over charge types, not over days. Neither is used here.

### Not there

**Nothing carries a shortfall forward.** Each day's bill is computed
independently from the schedule. Yesterday's 500 exists as a number on a receipt
and influences nothing.

**The waterfall is not wired to the agent path.** `post_instalment_waterfall` is
called only by `record_rent_request_repayment_v2`.
`agent_allocate_tenant_payment_internal` — the routine behind every agent
collection — does not reference instalments at all. And
**`instalment_allocations` has 0 rows**, so the waterfall has never run in
production.

That means there are two parallel repayment paths, and the arrears-aware one is
not the one agents use. Deciding which becomes canonical is the first real
engineering decision here.

**No allocation order.** A collection reduces `rent_requests.amount_repaid` as a
single running total. Nothing records which day a payment settled, so "did they
cover yesterday first" is currently unanswerable from the data.

---

## 5. Assessment

**The direction is right, and it is better than gating.**

It fixes the specific unfairness already documented: agents receive no credit for
arrears recovery. On 8 September, 83.5% of one agent's collections was recovery
on plans that had fallen off the bill, and it scored as nothing against his
target. Under this design that money has an obligation to land against and can be
credited.

It also replaces a defensive rule with a constructive one. Blocking collection
hurts the tenant and the agent; carrying the balance forward keeps the money
moving while making the debt visible.

**But it does not, on its own, solve the larger arrears problem.**

Rule 1 carries a shortfall to "the next repayment". A plan past its
`obligation_end` **has no next repayment** — its schedule is exhausted, so the
carry has nowhere to land. That is the population from the earlier analysis:

| | |
| --- | ---: |
| Plans past their cycle, still owing | **427** |
| Agents affected | 36 |
| Outstanding | **129,037,935** |

So Rules 1 and 2 fix **in-cycle** arrears — a tenant falling behind while their
schedule is still running. The **post-cycle** 129M still needs the separate
arrears line from option (a) in the team message. The two are complementary, not
alternatives, and it would be easy to mistake one for the other.

**One correction to what was circulated earlier.** The team message warned that
"a meaningful share of what we have been reading as tenants falling behind is our
own screen showing the wrong number." That is true for weekly plans, where the
collection screen was offering one seventh of the real instalment — but weekly
plans are only **5.1%** of the recorded shortfall. The other 94.9% is daily plans
genuinely paying short. The policy is therefore **not** materially distorted by
that bug, and does not need to wait on it. (The bug is fixed as of today, so
future stamps are correct: expected now comes from the pinned bill, and reads 0
on days nothing is due, so a non-due day is no longer mislabelled partial.)

---

## 6. Decisions still needed before this can be built

1. **Which repayment path is canonical?** Wire `post_instalment_waterfall` into
   `agent_allocate_tenant_payment`, or keep two paths and reconcile? Leaving two
   is how the current split arose.
2. **Does the carry compound without limit?** A tenant short every day for a
   month accumulates a carry far beyond one instalment. Cap it, age it out, or
   let it run? This determines whether "amount to collect" stays realistic.
3. **Carry per plan or per tenant?** A tenant with two plans could have the
   shortfall on one absorb capacity meant for the other.
4. **Is `is_partial` judged against the scheduled amount or scheduled + carry?**
   Under Rule 1 a tenant paying exactly 4,500 against a 5,000 obligation is
   short — but they paid the scheduled amount in full. Both readings are
   defensible and they produce different partial-collection reports.
5. **Does agent float gate the larger amount?** The collection is capped by
   float and outstanding. A 5,000 obligation against 4,500 of float means the
   arrears cannot be cleared even when the tenant has the cash.
6. ~~**Does the arrears view credit recovery toward the 50% gate, or only
   display it?**~~ **Decided: display and recognise, but do not credit the gate.**
   The gate is a risk control on new lending, so only money settling a currently
   scheduled day counts toward it; arrears recovery is credited in performance and
   incentive reporting instead. Reasoning in
   [`arrears-carry-forward-settlement-order.md`](./arrears-carry-forward-settlement-order.md) §3.

With item 6 settled, **item 1 — which repayment path is canonical** — is answered
too: phase 1 attributes days from the agent collection path, off the pinned bill,
and does not use `post_instalment_waterfall`.

---

## 7. Suggested sequence

1. **Show arrears first** — an agent-facing view of carried shortfall per tenant,
   read from the `shortfall_amount` already recorded. No schema change, no
   behaviour change, immediately useful, and it surfaces the 12,874,625 that is
   currently invisible.
2. **Decide item 6**, because it changes what step 3 has to compute.
3. **Wire the waterfall** into the agent collection path so payments allocate to
   specific instalment dates. This is Rule 2, and it makes Rule 1 derivable
   rather than a second bookkeeping system.
4. **Layer the carry** into "amount to collect", leaving the pinned bill and the
   daily target untouched.
5. **Separately**, the post-cycle arrears line for the 427 plans / 129M.

Step 1 is worth doing regardless of how items 1–6 land.
