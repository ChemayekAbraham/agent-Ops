# Phase 4, explained without the jargon

**What was built on 25 September 2026, why, and what it means day to day.**
Written for anyone who needs to understand the money, not the code.

This document explains what now exists and answers the questions asked of it.

> **Updated the same evening.** Three things changed after the first version:
> the rule now starts **next week** rather than tomorrow, Landlord Operations
> and the CFO now have a **screen** for these cases with actions on it, and the
> **last fee hole is closed**. Who is allowed to return landlord money has also
> been tightened. All of it is described below; the corrected figure for the
> historical fee gap is in section 6.

---

## 1. The problem, in one paragraph

When the CFO releases rent money, it does not go straight to the landlord. It
lands in the **agent's landlord-float wallet**, and the agent is the one who
actually pays the landlord. That is deliberate — the agent is on the ground and
knows the landlord.

But until now, nothing watched what happened next. If an agent simply never paid
the landlord, the money sat in their wallet indefinitely. Nobody was told, no
clock ran, and the tenant had a Rent Plan on the books for rent their landlord
had never received.

**Right now there is UGX 13,390,000 sitting like that** across 42 cases. The
oldest has been waiting since **15 May 2026** — over four months. (The figure
was 11,390,000 across 38 cases when this was first written a few hours earlier.
It moves. That is rather the point.)

---

## 2. What Phase 4 added

Three things:

**A clock.** From the moment the CFO releases the money, the agent has 24 hours
to pay the landlord.

**Reminders.** The agent is texted at 6 hours and again at 18 hours while the
landlord is still unpaid. Nothing is sent between 10pm and 6am, because
landlord payouts are blocked overnight anyway and waking someone to do something
they are not allowed to do is pointless.

**A consequence.** If 24 hours pass and the agent never even tried to pay the
landlord, the money is automatically taken back, the tenant's Rent Plan is
cancelled, and the tenant is texted to say nothing is owed by them and the
request can be made again.

---

## 3. "Is the cancellation automatic?" — yes, but only in one narrow case

This is the part worth being precise about, because an automatic cancellation is
a serious thing to do to a tenant.

At the 24-hour mark the system looks at one question: **did the agent ever
actually try to pay the landlord?**

| What the agent did | What happens |
|---|---|
| **Never raised a payout at all** | **Automatic.** Money taken back, plan cancelled, tenant texted |
| **Raised a payout, and it failed** | **Nothing automatic.** A person is alerted to sort it out |
| **Raised a payout, still in progress** | **Nothing.** The money is moving |

### Why the middle row matters

There is a real case that shows why a blunt timer would be unfair.

An agent was given UGX 450,000 on 17 September. They raised the payout the very
next morning, the landlord approved it by OTP, and then **the payment failed** —
a merchant or network problem, nothing to do with the agent. They tried again
five days later.

A simple "24 hours or else" rule would have cancelled that tenant's Rent Plan on
19 September, punishing an agent who did everything right and a tenant who did
nothing at all. So the system deliberately does **not** cancel when a payment was
attempted. It raises a flag for a human instead.

### Nothing that already exists gets cancelled

This is important. When the rule was first tested against the real data, it
would have **immediately cancelled 27 tenants and pulled back UGX 7,990,000** —
because of that four-month backlog described above.

That would have been an ambush. Those agents were never told a deadline existed,
because it did not.

So the rule has a **start line: Monday 28 September 2026, midnight**. It applies
only to money released from that point on. Everything older is listed for a
human to work through one by one, and the system will never act on it by itself.

The start line was originally set for midnight tonight. It was moved out to
Monday for a plain reason: **today is Friday.** A rule that begins cancelling
tenants over a weekend, announced to nobody, is the same ambush with a shorter
fuse. Monday gives the whole week to tell agents the deadline exists before
anything is enforced — and anything funded between now and Monday simply joins
the manual list rather than being caught by a rule that did not exist when the
money left.

After that start line was added, the run of the rule did exactly this:

| | |
|---|---:|
| Cases being watched | 42 |
| **Automatically cancelled** | **0** |
| Held for a person to review (pre-existing) | 27 |
| Flagged because a payment was attempted and failed | 14 |

---

## 4. "Where does the cancellation happen?"

The automatic one runs **by itself in the background**, on a check every 15
minutes. Nobody presses anything.

What it produces is a **list**: a record of every case where landlord money is
sitting unpaid, with how long it has been waiting, how urgent it is, and what
was decided.

### There is now a screen for it

**Landlord Operations → Payouts → "Float Not Paid Out"**, and the same panel on
the **CFO dashboard** under Landlord Payout Float. This is new, and it is the
answer to "we need to be able to see these and do something about them".

It shows four tabs:

| Tab | What is in it | Today |
|---|---|---:|
| **Needs action** | Live cases inside the 24-hour window | 1 · 500,000 |
| **Before the rule** | The backlog the system will never touch | 27 · 7,990,000 |
| **Payout failed** | A payment was attempted and failed | 14 · 4,900,000 |
| **Closed** | Dealt with, kept for the record | — |

Each case shows the landlord, the tenant, the agent **with a phone number you
can tap**, how long the money has been sitting, and — where there is one — the
exact payout error. Where the system will not act by itself, it says so on the
case, in words, so nobody assumes something is being handled that is not.

Four things can be done to a case:

- **"I am working this"** — puts your name on it so two people do not chase the
  same agent
- **"Just record a note"** — what you found, kept on the record
- **"Close without returning"** — the money is fine, or it is being handled
  elsewhere
- **"Return the float now"** — the manual version of the automatic recall,
  available immediately and without waiting for any clock. This is the only way
  the 27 old cases will ever be cleared.

**Every one of them requires you to type what you decided**, at least a full
sentence. It is stored against the case and in the audit log with your name.
The return button asks you to confirm in plain words what it will do first.

A decision a person makes now **sticks**: the background check leaves a case a
human has closed completely alone rather than reopening it or overruling it on
the next pass.

Each case ends up marked as one of:

- **auto recalled** — the clock ran out, money taken back, plan cancelled
- **manually recalled** — a person decided, money taken back, plan cancelled
- **escalated** — a payment was attempted and failed, needs a person
- **held for manual review** — from before the rule started
- **dismissed** — a person looked and decided to leave it
- **resolved** — the landlord was paid after all, so it closed itself

---

## 5. "Can the CFO return the float themselves?" — yes, three ways

Returning landlord float is not only automatic. There are three routes, and all
three have existed or now work properly.

### Who is allowed to, as of today

This was tightened. Returning landlord money now sits with **four roles only**:

> **CFO · Landlord Operations · CTO · Super Admin**

**An agent cannot return float. They request it, and one of the four decides.**
That has not changed and is not negotiable — it is the whole control.

What did change, in both directions:

- **Seventy-four people could previously cancel a tenant and pull back their
  landlord's rent** — anyone holding Manager, Operations, COO or Financial Ops.
  Twenty-one of them lose that. They can still *see* the register and leave
  notes; they can no longer move the money.
- **One person on the entire platform could approve an agent's return request.**
  The rule was not "the CFO" — it was a named list with a single member on it.
  That is why requests sit pending for days. It is now the four roles.

### Route 1 — the CFO or Landlord Ops does it directly

Cancel a tenant and pull the money back at any time. A reason of at least 10
characters is required and is stored.

> **This route was broken and nobody knew.** The record it tries to write had a
> required field the code never filled in, so **every attempt to return money
> from a plan that still had float would have failed**. That is why the
> underlying table holds exactly **one** record, and only **four** plans have
> ever been cancelled this way. It was fixed as part of this work, because the
> automatic rule needed the same path to work.

### Route 2 — the agent asks, the CFO decides

An agent can request that float be returned, and the CFO approves or rejects it.
This is in active use: **62 requests so far, 39 approved, 21 rejected, 2 waiting
right now.**

### Route 3 — automatic, as described above

All three end in the same place: the money goes back, the agent's float drops,
and the tenant's plan is closed.

---

## 6. "Are the books still balanced?" — yes, and one long-standing hole was closed

Short answer: **yes, and the accounting is now more correct than before this
work.**

### What was quietly wrong

When the CFO releases rent money, the company records two things:

1. the **rent itself**, which the tenant will repay, and
2. the **fees** — the access fee and the registration fee — which the tenant
   also owes and which eventually become company income.

When a plan was cancelled, only the **rent** was undone. The **fees stayed on
the books for ever**, recorded as money owed by a tenant whose plan no longer
existed, matched by a corresponding amount held on the other side of the balance
sheet that nothing would ever clear.

On a typical UGX 250,000 plan that is about **UGX 100,000 left behind every time**.
One already-closed plan carries **UGX 119,000** of exactly this.

That was tolerable while cancellations were rare and manual. With an automatic
rule it would have become routine, quietly inflating what the company appears to
be owed, for ever.

### What now happens

Cancelling a plan now also reverses the fees — the exact mirror of what was
recorded when the money was released. Tested on a real plan: **UGX 119,000
removed from both sides**, perfectly balanced.

It is careful in two ways that matter:

- **If the tenant already repaid something**, only the untouched portion is
  reversed. What they genuinely paid stays as real income.
- **If it runs twice**, the second run does nothing. It cannot double-reverse.

And because this was added to the shared cancellation step, **all three routes
above get it** — the CFO's own button, the agent-requested route approved by the
CFO, and the automatic rule.

### The second hole — now closed

There was a second, older route that also unwinds plans — the agent-requested
one, route 2 — taking a **different internal path** that did not reverse the
fees. It now does, through exactly the same mechanism. Tested against a real
pending request before it was committed: **UGX 119,000 reversed, both sides,
balanced**, then rolled back.

**A correction to the figure in the first version of this document.** It said
*"3 cases have left fees behind, totalling UGX 254,500."* That was wrong, and
wrong in a way that mattered — it counted money the company genuinely is owed.

Of 37 approved returns, four carry a recognised fee. Three of those four are on
plans that were **funded again afterwards** and are alive today, one of them
currently repaying. Their fee receivable is real. Reversing it would have
deleted income the platform has actually earned.

**The honest stranded figure is one plan, UGX 119,000** — a plan that ended in
`rejected` and will not come back.

| | |
|---|---:|
| Approved returns carrying a fee | 4 |
| …of which re-funded and live today | 3 · 135,500 (**not** stranded) |
| **…genuinely stranded** | **1 · 119,000** |

Nothing historical was corrected. The one stranded case is listed for a person,
exactly like the 27.

### Something that turned up while closing it

Those re-funded plans exposed a quieter problem. The fee is recorded **once per
funding**, and the guard that stops it being recorded twice was not checking
whether it had since been reversed. So the moment route 2 started reversing
fees, a plan that was returned and then funded again would have carried **no fee
at all** — the platform would have quietly stopped charging some tenants.

That is fixed in the same change: a re-funded plan re-records its fee properly,
and doing it twice still does nothing. Both directions were tested and rolled
back.

---

## 7. What an agent actually experiences now

| When | What they get |
|---|---|
| CFO releases the money | Text: the money is in your wallet, pay the landlord |
| 6 hours later, still unpaid | Text: reminder |
| 18 hours later, still unpaid | Text: about 6 hours left, or the plan is cancelled |
| They pay the landlord | Text: landlord paid, receipt number, when the tenant starts, and the commission earned |
| 24 hours, never tried | Money taken back, plan cancelled |
| 24 hours, tried and it failed | **Nothing happens to them.** A person is alerted |

And the tenant:

| When | What they get |
|---|---|
| Their landlord is actually paid | Welcome message: repayment starts tomorrow, how much, for how long, the total, and who will collect |
| Their plan is cancelled | Message: this could not be completed, **nothing is owed by you**, it can be submitted again |

The landlord's message has not changed. They already receive a text with their
receipt number and a link, sent the moment the payment is confirmed.

---

## 8. The short version

- Agents now have **24 hours** to pass rent money to the landlord.
- If they **never try**, it is taken back automatically and the tenant is told
  they owe nothing.
- If they **try and it fails**, nothing happens to them — a person looks at it.
- **Nothing that already existed is touched.** The rule starts **Monday 28
  September**, not tonight — a working week's notice, not a weekend ambush.
- There is now a **screen** for all of this, in Landlord Ops and on the CFO
  dashboard, with a phone number, a reason box and four actions per case.
- **Only the CFO, Landlord Ops, the CTO and Super Admins may return float.**
  Agents request; they never decide. Twenty-one people lost the ability to
  cancel a tenant; the single-person bottleneck on approving agent requests is
  gone.
- **Both** unwinding routes now properly reverse the fees, which neither did
  before — and a re-funded plan correctly starts charging again.
- **UGX 13,390,000** of idle landlord money is now visible and actionable for
  the first time, some of it four months old. That list is worth someone's
  morning.

---

## Terminology

Rent Plan (never "loan"), Supporter (never "lender"), Returns (never "interest").
All amounts UGX. Figures read from production on 25 September 2026.
