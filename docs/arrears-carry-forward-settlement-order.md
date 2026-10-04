# Settlement order, and where the carry goes when a plan ends

**Status: phase 1 built and applied 9 September 2026** — see
[`arrears-phase1-shipped.md`](./arrears-phase1-shipped.md). Follow-up to
[`arrears-carry-forward-design.md`](./arrears-carry-forward-design.md), covering
the refinement to Rule 1 and the "what if the plan is complete" case.

Figures re-derived from production on **9 September 2026**. Re-derive before
quoting.

---

## 1. The refinement

Rather than inflating the next obligation, split the payment:

- **The daily target displays only what is scheduled** for that day. Unchanged
  by arrears.
- **When a payment arrives, arrears are settled first**, and the remainder is
  what gets credited to today:

```
credited_today = amount_paid − arrears_cleared
```

### The shortfall is a pending balance, not a daily charge

This is the point to be unambiguous about, because it is easy to read the rule
the wrong way.

The 500 is billed **once**. It then sits as an unpaid balance until it is
cleared. It is never re-charged, it does not attract any additional amount, and
the scheduled figure stays 4,500 for every subsequent day. What the rule changes
is not *how much is owed* but *where an incoming payment lands*: the oldest
unpaid amount is settled first, and only the remainder counts toward the current
day.

**Case A — a one-off shortfall, then normal payment.** The ordinary case, and the
one that shows the mechanism cleanly:

| Day | Scheduled | Pending in | Paid | → pending | → today | Pending out |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 4,500 | 0 | 4,000 | 0 | 4,000 | **500** |
| 2 | 4,500 | 500 | 4,500 | 500 | 4,000 | **500** |
| 3 | 4,500 | 500 | 5,000 | 500 | 4,500 | **0** |
| 4 | 4,500 | 0 | 4,500 | 0 | 4,500 | **0** |

On day 2 the tenant pays the scheduled 4,500; 500 of it clears day 1, so only
4,000 lands on day 2 — which leaves day 2 itself 500 short. The balance stays at
500 and simply moves along until someone pays 5,000 once, on day 3. After that
it is gone. **The 500 was charged one time and cleared one time.**

**Case B — chronic underpayment.** If the tenant keeps paying 4,000 against a
4,500 schedule, the pending balance does rise — but only because **each new day
contributes its own new 500 shortfall.** The original 500 is not growing, and
nothing is charged twice:

| Day | Scheduled | Pending in | Paid | → pending | → today | Pending out |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 4,500 | 0 | 4,000 | 0 | 4,000 | **500** |
| 2 | 4,500 | 500 | 4,000 | 500 | 3,500 | **1,000** |
| 3 | 4,500 | 1,000 | 4,000 | 1,000 | 3,000 | **1,500** |
| 4 | 4,500 | 1,500 | 4,000 | 1,500 | 2,500 | **2,000** |
| 5 | 4,500 | 2,000 | 4,000 | 2,000 | 2,000 | **2,500** |

Check it the simple way: after five days the tenant owed 22,500 and paid 20,000,
so the balance is 2,500 — five separate 500 shortfalls, one per day. Straight
line, no compounding.

Nothing is hidden and nothing is double-counted. The target never moves off
4,500.

> **Correction.** An earlier version of this document showed the balance in
> Case B running 500 → 1,500 → 3,500 → 7,500 → 12,000. That was wrong: it added
> the incoming balance to the outgoing figure instead of netting off the part the
> payment had just cleared, which made the balance look as though it doubled
> daily. It rises by 500 a day, and only because each day adds a fresh shortfall.
> The earlier version also described this as debt that "accrues" — the wrong
> word. Nothing accrues; an unpaid amount simply stays unpaid.

---

## 2. Does this address the Rule 1 problem? Yes — the one I raised

My objection to the original phrasing was that folding the carry into the
obligation inflates the **denominator** without limit. An agent carrying a
chronically short tenant would see their target grow past anything collectable
and be blocked from posting new Rent Plans for a shortfall that is not theirs.
That was not hypothetical — we watched a target balloon to 1.9M against a book
that collects ~178,000/day, needing ~963,000 in a single day to stay eligible.

This refinement removes that entirely. **The target stays fixed at the scheduled
amount.** Correct call.

## 3. But it relocates the problem rather than removing it

This applies to **Case B only** — a tenant who keeps underpaying. A one-off
shortfall (Case A) clears in a day or two and has no meaningful effect on the
agent.

Look at the `→ today` column in Case B. It falls 4,000 → 3,500 → 3,000 → 2,500 →
2,000 while the agent pays exactly the same 4,000 every single day.

So instead of the denominator inflating, the **numerator deflates** — by 500 a
day. It reaches zero on **day 9**, when the pending balance finally equals one
whole instalment (9 × 500 = 4,500) and the entire payment goes to clearing it.
From then on the agent brings in 4,000 a day and is credited nothing. Against
the 50% eligibility gate they would be blocked, for working a difficult tenant.

This is a slow drift rather than a cliff, and it only bites on tenants who are
persistently short. It matters because it is the same shape of unfairness we have
now hit three times:

- settling a plan erased the payment that settled it — fixed
- arrears recovery on post-cycle plans scored as zero — documented, 129M
- and now: clearing arrears in-cycle would score as zero against the gate

You noted "this will affect today's limit… which is correct". For the **tenant's
account** that is exactly correct and should not change.

### The resolution: the gate is not a scoreboard

**Decided: arrears recovery does not count toward the 50% eligibility gate.**

I argued the opposite above and was wrong. The gate is not a performance score —
it is a risk control on **new lending**. It asks one question: is today's book
being serviced well enough to justify placing more capital into it? Only money
that settles a **currently scheduled** obligation answers that question. Letting
old arrears satisfy it makes the gate gameable: an agent could unlock new Rent
Plans by clearing months-old debt while today's tenants go uncollected — which is
precisely the risk the gate exists to prevent.

So the separation is not tenant-ledger versus agent-ledger. It is **gate versus
credit**:

| | Basis | Used for |
| --- | --- | --- |
| **Eligibility gate** | today's pinned bill as the denominator; only the portion of collections settling today's scheduled days as the numerator | whether the agent may post a new Rent Plan |
| **Recognition** | all cash the agent brought in, arrears recovery included | performance views, incentives, commission, agent-ops reporting |
| **Tenant account** | waterfall — arrears first, `credited_today = paid − arrears_cleared` | the tenant's balance and statements. Your rule, unchanged. |

Arrears recovery is still visible and still rewarded — just not through the
lending gate. That keeps the gate honest about risk without punishing the agents
doing the hardest work, which was the real concern behind §3.

> **Correction.** An earlier version of this section concluded that arrears
> recovery "must" count toward the 50% gate, and framed the split as tenant
> ledger versus agent ledger. That was the wrong conclusion for the reason above:
> the gate controls new lending, and crediting arrears against it lets an agent
> unlock capital without servicing today's book. Recognition and eligibility are
> different surfaces and only recognition should credit arrears.

---

## 4. "What if a rent request is complete now?" — three cases, and only one is safe

You are right that this was not covered. The carry needs somewhere to land, and
in two of three cases there is nowhere.

### Case A — completed, balance zero

Nothing to carry. Safe, and the common path. Historically **2,730,526 of
shortfall across 48 receipts** sat on plans that later completed — arrears that
resolved themselves as the schedule ran on. Under this design they would have
been carried and cleared in the normal course.

### Case B — schedule ended, still `repaying`, still owing

The plan's instalments are exhausted, so there is **no next repayment for the
carry to attach to**. This is the population already documented — 427 plans, 36
agents, 129,037,935 outstanding — and of that:

| | |
| --- | ---: |
| Plans past schedule with recorded shortfall | **160** |
| Shortfall already recorded on them | **5,907,162** |

So Rule 1 works *in-cycle* and goes silent the moment the schedule ends. The
carry needs a terminal destination.

### Case C — `status = 'completed'` **and still owing**

This one is new, and it is a data-integrity finding rather than a design gap.
`completed` does not reliably mean "fully repaid": **6 plans are marked completed
while still owing 2,560,333 between them.**

| Still owed | Repaid | Last collection |
| ---: | ---: | --- |
| **1,431,582** | **0.0%** | **never** |
| 447,170 | 27.7% | never |
| 416,381 | 92.2% | 2026-07-02 |
| 133,000 | 80.6% | 2026-07-09 |
| 91,800 | 47.9% | 2026-07-16 |
| 40,400 | 47.9% | 2026-07-04 |

All six are `daily`, all have `tenancy_status = 'active'`, none carry any
recorded shortfall, and four last saw a collection in July.

The top row deserves attention on its own: a plan funded for **1,431,582** that
has **never received a single shilling** and is now marked complete. Money went
to the landlord and nothing came back. Whether that is a write-off, a data error
or an administrative closure, nothing in the product is tracking it.

These six are invisible to every target and every coverage figure, because the
eligibility view only admits `funded` and `repaying` plans.

### What this means for the design

The carry rule is well-defined while a plan is mid-schedule and undefined
everywhere else. It needs one more clause: **when the schedule ends or the plan
closes with a balance, the remaining carry becomes an arrears obligation that
survives the plan** — which is the arrears line from option (a) in the team
message. Rules 1 and 2 and that line are one feature, not three.

Until then, any carry that reaches the end of a schedule silently disappears,
which is the behaviour we are trying to fix.

---

## 5. Open items

Carried forward from the previous document, with the new ones added:

1. ~~**Does clearing arrears count toward the 50% gate?**~~ **Decided: no.** The
   gate is a risk control on new lending, so only money settling a currently
   scheduled day counts toward it. Arrears recovery is credited in performance
   and incentive reporting instead (§3).
2. **Terminal rule for the carry** when a schedule ends or a plan closes owing
   (§4, cases B and C). Without it Rule 1 is incomplete.
3. **`status = 'completed'` is not trustworthy** as "fully repaid" — 6 plans
   prove it. Either the status is wrong on those rows, or the system needs an
   explicit closed-with-balance state. Worth settling before anything keys off
   `completed`.
4. **Investigate the 1,431,582 plan** with zero repayment. Independent of this
   design.
5. **Which repayment path is canonical** — `post_instalment_waterfall` is wired
   only to `record_rent_request_repayment_v2`, and `instalment_allocations` has
   0 rows, so the waterfall has never run. The refinement in §1 *is* a waterfall;
   building it means either wiring that machinery into the agent path or
   duplicating it.
6. **When does a persistent shortfall stop being arrears and become default?**
   Nothing compounds — the balance only rises because each new day adds a fresh
   shortfall (§1, Case B). But it rises without limit for as long as the tenant
   keeps underpaying, and at some point they are not behind, they have
   defaulted. The product should say so rather than carrying a balance forward
   indefinitely.
7. **Is `is_partial` judged against the scheduled amount or scheduled + carry?**
8. **Does agent float gate the larger collection?** Clearing arrears plus today
   needs more float than today alone.

With item 1 settled, **item 2 — the terminal rule for a carry when a schedule
ends or a plan closes owing** — is the one left that decides whether this ships as
a fix or as a better-instrumented version of the same problem.
