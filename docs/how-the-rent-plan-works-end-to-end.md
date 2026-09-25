# How a Rent Plan works, end to end

**A plain-language guide to what happens from the moment an agent posts a rent
request to the day the tenant finishes paying — including every message we send,
who gets it, and what happens when things go wrong.**

Written 25 September 2026. Figures read from production the same day.
No prior knowledge assumed.

---

## Contents

1. [The whole journey in one page](#1-the-whole-journey-in-one-page)
2. [Stage 1 — the landlord and the house](#2-stage-1--the-landlord-and-the-house)
3. [Stage 2 — the agent posts the rent request](#3-stage-2--the-agent-posts-the-rent-request)
4. [Stage 3 — the approval desks](#4-stage-3--the-approval-desks)
5. [Stage 4 — the CFO releases the money](#5-stage-4--the-cfo-releases-the-money)
6. [Stage 5 — the agent pays the landlord](#6-stage-5--the-agent-pays-the-landlord)
7. [Stage 6 — the tenant starts repaying](#7-stage-6--the-tenant-starts-repaying)
8. [Stage 7 — collecting, day after day](#8-stage-7--collecting-day-after-day)
9. [When the tenant part-pays](#9-when-the-tenant-part-pays)
10. [When the tenant misses a day](#10-when-the-tenant-misses-a-day)
11. [When the agent never pays the landlord](#11-when-the-agent-never-pays-the-landlord)
12. [What the agent earns, with real numbers](#12-what-the-agent-earns-with-real-numbers)
13. [Every message we send, in one table](#13-every-message-we-send-in-one-table)
14. [What changed, what is live, what happens Monday](#14-what-changed-what-is-live-what-happens-monday)
15. [Where things actually stand today](#15-where-things-actually-stand-today)

---

## 1. The whole journey in one page

A Rent Plan is simple to describe: **Welile pays a tenant's rent to their
landlord, and the tenant pays Welile back in small daily amounts.** An agent does
the legwork at both ends — finding the landlord, placing the tenant, carrying the
money, and collecting every day.

```
  AGENT                    WELILE                    LANDLORD        TENANT
    │
    ├─ registers landlord ──►  verified                              
    ├─ lists empty house ───►  verified
    │
    ├─ posts rent request ──►  five desks check it
    │                          │
    │                     CFO releases the money
    │   money lands in ◄───────┘
    │   agent's wallet                                     
    │      │
    │      ├─ agent pays the landlord ──────────►  gets the rent
    │      │                                       + a receipt
    │      │
    │      └─────────────────►  plan becomes REPAYING ────────► "you start
    │                                                             tomorrow"
    │
    └─ collects daily ◄──────────────────────────────────────────  pays daily
           │
           └──►  agent earns 10% of every shilling collected
```

**The important idea:** the tenant does not start paying when the plan is
approved. They start the day after **their landlord actually has the money**.
Until that happens, nothing is owed by anyone.

---

## 2. Stage 1 — the landlord and the house

Before any tenant can be helped, the agent brings a landlord into the network and
lists an empty house.

**What happens:** the agent registers the landlord's details, and Landlord
Operations or a service centre verifies them. The same for the house.

**What the agent earns:**

| | |
|---|---:|
| New landlord verified | **UGX 5,000**, once per landlord ever |
| Empty house listed and verified | **UGX 2,000** |
| New LC1 chairperson verified | **UGX 2,000** |

A landlord already in the system earns nothing. That is the point — the 5,000 is
for *bringing someone new in*, not for naming them again.

**A safeguard added this month.** As the agent types a landlord's name, the system
checks the register live and warns if someone very similar already exists in the
same village. If it is clearly the same person, it blocks. This exists because we
found **2,171 duplicate LC1 records** — one name and village repeated **193
times**.

**Messages sent:** none to the tenant or landlord at this stage. The agent sees
the bonus credited in their wallet.

---

## 3. Stage 2 — the agent posts the rent request

The agent enters the tenant, the house, the rent and the repayment period.

**Twenty-one checks run before the request is even saved.** Among them: the
landlord must exist and be verified, the tenant must have a photo, the location
must have real GPS, there must be a signed landlord agreement, and the request
must not duplicate one already in flight.

**One check surprises agents most.** An agent who already has active tenants must
have collected **at least 50% of what those tenants owe today** before they can
post a new request. If they have not, the request is refused with a message
saying so. It is deliberate: an agent who cannot keep up with the tenants they
have should not be given more.

**Pricing is not negotiable.** The agent cannot set the fees. The system
calculates them:

| For a 30-day plan | Formula | On UGX 250,000 |
|---|---|---:|
| Access fee | 33% of the rent | 82,500 |
| Registration fee | 10,000 up to 200,000 rent, else 20,000 | 20,000 |
| **Total the tenant repays** | rent + both fees | **352,500** |
| **Daily amount** | total ÷ days | **11,750** |

**What the agent earns at this stage: nothing.**

This changed this month. Posting a rent request used to trigger a bonus. It no
longer does, because posting a request is not delivery — it is paperwork.

**Messages sent:** the tenant may receive intake and progress messages while
their file is being completed.

---

## 4. Stage 3 — the approval desks

The request passes through **five desks**: Agent Ops, Tenant Ops, Landlord Ops,
Partner Ops, and finally the COO.

**What the agent earns at any desk: nothing.** No desk has ever paid a bonus and
none does now.

**Messages sent:** none to the tenant or landlord. Staff see the queue.

> **Worth knowing:** there are currently **3,804 requests sitting at the first
> desk**. That is more than five times the number of tenants actively repaying.
> Nothing in this document changes that backlog, but it is the real bottleneck in
> the business.

---

## 5. Stage 4 — the CFO releases the money

**This is the moment the money leaves the company.**

The CFO approves the request and releases the rent into the **agent's landlord
float wallet**. Not to the landlord — to the agent.

### Why the agent, and not the landlord directly?

Because the agent is standing in front of the landlord. They know which phone
number is really the landlord's, they can see the house, and they can sort out a
problem on the spot. A payment sent blind from an office to a number on a form is
how money goes to the wrong person.

The trade-off is obvious: **the money now sits with a person, and a person can
sit on it.** That is the problem the new 24-hour rule solves — see section 11.

### What happens the instant the CFO approves

Three things, in the same breath:

1. The rent is **earmarked for that specific tenant's landlord**. The agent cannot
   spend it on anything else.
2. The plan's status becomes **funded**.
3. **A 24-hour clock starts.**

### The message the agent gets

> UGX 250,000 landlord float is in your wallet to pay Ssemakula Joseph (for
> Nakato Grace).
>
> Please pay the landlord and submit the TID and receipt. The tenant starts
> repaying the day after the landlord is paid.
>
> Payouts run 06:00–22:00.

**Nobody else is told yet.** The tenant is not messaged, the landlord is not
messaged. This is deliberate — nothing has actually happened for either of them
yet, and telling a tenant "your rent is paid" before it is would be a lie.

### What the agent earns here

**Nothing.** This also changed this month.

Releasing money to an agent used to pay them **UGX 15,000** — a flat 5,000 plus a
10,000 bonus — and paid their recruiting parent another 3,000. All three are
gone. The agent is now paid when the landlord actually receives the money, not
when the company hands over the cash.

Across the platform this removed roughly **UGX 15,000 per funded plan**. On a
250,000 plan an agent's total earnings fall from 59,750 to 44,750.

---

## 6. Stage 5 — the agent pays the landlord

The agent goes to the landlord and sends the money by mobile money from their
float.

### The landlord proves it is them

Before the payout goes out, the landlord receives a **one-time code on their own
phone** and must read it back. This is the control that stops an agent paying
their own number and claiming it was the landlord.

> **To the landlord:** Landlord payout OTP …

### Then the money moves

The payout goes to the merchant, the merchant pays the landlord, and Financial
Operations confirms it with a mobile-money reference.

### The landlord's receipt

The moment the payment is confirmed, the landlord gets a real receipt:

> Welile: Dear Kavuma Ibrahim, you have received UGX 100,000 as rent for
> Kyomukama Sauda Hellen. Processed by Shamirah Nakajjubi on 24 Sept 2026,
> 20:50. Receipt No: WLR-100333. View your receipt:
> https://welileapp.com/r/CEB2NVTM9U
>
> For assistance, contact Welile Support on 0748747134.

That receipt number is permanent and the link is public — the landlord can show
it to anyone.

### The agent's message

> UGX 250,000 has been paid to landlord Ssemakula Joseph. Receipt No WLR-100334.
>
> Nakato starts repaying TOMORROW, Saturday 26 September: UGX 11,750 per day.
>
> You earned UGX 2,500 commission.
>
> Please upload the receipt.

### What the agent earns here

**1% of the payout** — UGX 2,500 on a 250,000 plan.

This replaced the old flat 5,000. It is worth **less** than 5,000 on payouts
below half a million and **more** above it, which matches the effort and the risk
of carrying a larger sum.

---

## 7. Stage 6 — the tenant starts repaying

### The rule, stated exactly

> **A Rent Plan becomes "repaying" the moment the landlord actually receives the
> money. The tenant's first payment day is the day after that.**

Not when the plan is approved. Not when the CFO releases the funds. Not when the
payout is handed to a merchant. **When the landlord has it.**

### Why this matters so much

Before this change, the first payment day was set to *the day after funding*. So
if the CFO released money on Monday and the agent paid the landlord on Thursday,
the tenant was billed for **Tuesday, Wednesday and Thursday** — three days they
were never told about, for rent their landlord did not yet have.

The agent would open their app on Friday and see the tenant already behind. Two
real tenants were found in exactly this state.

The daily bill is written once at five past midnight and **can never be
changed**. So a wrong start date is not a display bug — it is permanent debt
invented out of nothing.

That is now fixed. Of **24 plans** that started repaying under the new rule today,
**every single one** starts exactly one day after its landlord was paid. Not one
is early.

### The tenant's welcome message

This is the first time the tenant hears from us since the request was posted:

> Welcome to Welile, Grace.
>
> Your rent of UGX 250,000 has been paid to your landlord Ssemakula Joseph.
>
> Your repayment starts TOMORROW, Saturday 26 September:
>   UGX 11,750 per day
>   for 30 days
>   Total to repay: UGX 352,500
>
> Your agent Ian Muhwezi (+256700000000) will collect from you.

Everything the tenant needs is in one message: what was paid, to whom, when they
start, how much, for how long, the total, and who is coming.

> **Weekly plans say "per week"** and quote the weekly figure, not the daily one.
> A tenant told "UGX 11,750" who is then asked for 82,250 on Friday will feel
> cheated, and that has happened before.

---

## 8. Stage 7 — collecting, day after day

### How the daily bill is made

At **five past midnight every night**, the system writes one line per active
tenant: *this tenant owes this much today*. That is the bill, and it is fixed.

A plan funded during the day is **not** on that day's bill — it goes on
tomorrow's. That is correct, not a delay.

### How a collection actually works

Here is the part most people get wrong.

**The agent is spending their own money.** They pre-fund a float wallet, and when
they record a collection, that float is debited and the plan is settled. They
keep the cash the tenant hands over.

Nothing in the system checks that the tenant physically paid. It does not need
to — **the agent is out of pocket the instant they record it.** That is the
control, and it is a strong one.

### What the tenant gets, every time

> WELILE: Hi Nanono, paid UGX 11,750. Balance UGX 340,750.
> Card: https://welileapp.com/limit/…

And a fuller message when the day is cleared:

> Welile: We received UGX 11,750. Today's rent obligation is fully cleared. Your
> balance is UGX 340,750. You have now paid UGX 11,750 of UGX 352,500, leaving
> UGX 340,750 to pay. Your payment cycle ends in 29 days. Pay UGX 200,300 more to
> qualify for rent of up to UGX 300,000. Pay directly via MTN 090777 or Airtel
> 4380664.

Note the last two sentences. Every payment message tells the tenant **what
paying well earns them** — a bigger rent limit next time — and **how to pay us
directly** without waiting for their agent.

### What the agent earns

**10% of every shilling collected.** On a 250,000 plan that is 1,175 a day, and
**UGX 35,250** over the full 30 days.

If the collector is a sub-agent: **the sub-agent keeps 8% and their recruiting
parent takes 2%.** Some whitelisted sub-agents keep the full 10%.

The commission lands in the agent's withdrawable balance immediately — not at
month end.

> **Today, 28 agents earned UGX 129,661 in collection commission.**

### If a tenant pays Welile directly

Tenants can pay us straight through mobile money without seeing their agent. When
they do, **the agent still gets their commission** — the relationship is
recognised:

> Welile: Martha Namigadde part-paid their rent directly.
> Received: UGX 21,445 of UGX 34,445 for today.
> Your commission is already in your withdrawable balance.
> Rent balance: UGX 190,667.

---

## 9. When the tenant part-pays

A tenant who can only find part of today's money is **not** treated as having
paid nothing. That was a specific instruction, and it matters.

### What happens

The amount received is recorded, today's day stays partly open, and the shortfall
**carries forward**. Nothing is penalised, nothing is written off.

### What the tenant is told

> Welile: We received UGX 3,000. Today's due was UGX 13,967. UGX 10,967 remains
> and will carry forward. You have now paid UGX 80,000 of UGX 419,000, leaving
> UGX 339,000 to pay. Pay UGX 213,300 more to qualify for rent of up to UGX
> 419,000. Pay directly via MTN 090777 or Airtel 4380664.

The message says plainly what came in, what was due, what is left, and where they
stand overall. **It never reads as "nothing received".**

### Worked example

Grace owes 11,750 a day. On day 4 she only has 5,000.

| | |
|---|---:|
| Paid | 5,000 |
| Still owed from day 4 | 6,750 |
| Owed on day 5 | 11,750 + 6,750 = **18,500** |

Her agent earns 10% of the 5,000 — **500** — straight away, and will earn 10% of
the rest whenever it comes.

This message goes out within **20 minutes** of the payment.

---

## 10. When the tenant misses a day

### The ladder

Missing a day is not a crisis on day one. It becomes one slowly, and we escalate
in three steps.

| Day behind | What happens |
|---|---|
| **1** | Tenant gets an SMS the next morning |
| **4, 7, 10…** | Tenant gets another, every third day |
| **3, 6, 9…** | **The agent** is texted and a task is raised on them |
| **7** | The tenant is pushed into the **call centre** for a human phone call |

### The morning-after message

> Welile: Yesterday's UGX 11,750 rent payment was not received. It remains due
> and carries forward. Pay directly via MTN 090777 or Airtel 4380664.

Sent at **7am**, after the day has properly closed.

### The staying-behind message

> Welile: Your Rent Plan is behind by UGX 88,505 (7 days). Please pay today from
> your Welile wallet or through your agent. **Staying behind lowers your Welile
> Trust Score and your future rent limit.**

That last sentence is the real consequence. Nobody is penalised with a fee. What
they lose is **access** — how much rent Welile will fund for them next time.

### The agent is chased too

From day 3, the agent hears about it and a task appears on their list. An agent
who leaves a tenant alone for **5 days** gets a warning; at **8 days** their
account can be locked from taking on new tenants. For weekly tenants those
thresholds are 10 and 15 days.

### Nothing is invented

The arrears figure is always **capped at what the tenant genuinely still owes**.
A tenant cannot be shown as behind by more than their outstanding balance.

### Where this stands today

| | |
|---|---:|
| Plans currently behind | **387** |
| Total behind | **UGX 47,550,968** |
| Average days behind | 7.1 |
| Worst | 15 days |
| At agent-escalation stage (3+ days) | 315 |
| At call-centre stage (7+ days) | **190** |

---

## 11. When the agent never pays the landlord

This is the newest part of the system, and the most sensitive, because it can end
a tenant's Rent Plan automatically.

### The problem it solves

Money released to an agent sometimes simply stayed there. Nobody was told, no
clock ran, and a tenant had a Rent Plan on the books for rent their landlord
never received.

**Right now UGX 13,390,000 is sitting like that across 42 cases. The oldest has
been waiting since 15 May — over four months.**

### The rule

From the moment the CFO releases the money, the agent has **24 hours** to pay the
landlord.

**Reminders:**

| When | Message to the agent |
|---|---|
| 6 hours | *UGX 250,000 for landlord Ssemakula is still in your wallet. Please pay the landlord and submit the TID and receipt.* |
| 18 hours | *Reminder: … About 6 hours left. If the landlord is not paid, the float is returned and the Rent Plan is cancelled.* |

Nothing is sent between **10pm and 6am** — payouts are blocked overnight anyway,
and waking someone to do something they are forbidden from doing helps nobody.

### At 24 hours — three different outcomes

| What the agent did | What happens |
|---|---|
| **Never even tried** | Money taken back, plan cancelled, tenant told |
| **Tried and the payment failed** | **Nothing automatic.** A person is alerted |
| **Tried and it is still moving** | Nothing. The money is in flight |

### Why the middle row exists

A real case. An agent was given UGX 450,000 on 17 September. They raised the
payout the **very next morning**, the landlord approved it by code, and then **the
payment failed** — a network problem, nothing to do with them. They tried again
five days later.

A blunt timer would have cancelled that tenant's Rent Plan on the 19th,
punishing an agent who did everything right and a tenant who did nothing at all.

**So the system never cancels when a payment was attempted.** It raises a flag for
a human instead. **14 cases worth UGX 4,900,000** are sitting in exactly that
state now.

### What the tenant is told if their plan is cancelled

> Grace, the Rent Plan for your rent of UGX 250,000 could not be completed because
> the landlord payment was not made in time.
>
> **Nothing is owed by you.** Your agent can submit the request again.

This message matters more than any other in this document. A tenant whose plan is
unwound through no fault of their own must be told, in plain words, that they owe
nothing.

### Nothing that already exists gets cancelled

When the rule was first tested it would have cancelled **27 tenants** and pulled
back **UGX 7,990,000** immediately, because of the four-month backlog. Those
agents were never told a deadline existed.

**So the rule starts on Monday 28 September.** It applies only to money released
from then. Everything older is listed for a person to work through by hand, and
the system will never touch it by itself.

### Somebody can now see all of this

There is a new screen — **Landlord Ops → Payouts → "Float Not Paid Out"**, and the
same panel on the **CFO dashboard**. It lists every case, how long it has waited,
the agent's phone number, and what went wrong.

Four things can be done to a case: *I am working this*, *record a note*, *close
without returning*, or **return the float now**. Every one requires a written
reason that is kept on the record with your name.

### Who is allowed to take money back

**Only four roles: the CFO, Landlord Operations, the CTO and Super Admins.**

**An agent can never return float themselves.** They can *request* it, and one of
those four decides. That is the whole control.

---

## 12. What the agent earns, with real numbers

### A complete plan, start to finish — rent UGX 250,000 over 30 days

| Stage | Earned |
|---|---:|
| Empty house listed and verified | 2,000 |
| New landlord verified | 5,000 |
| Rent request posted | **0** |
| Five approval desks | **0** |
| **CFO releases the money** | **0** |
| **Landlord actually paid — 1%** | **2,500** |
| 30 collections at 10% | 35,250 |
| **Total** | **44,750** |

**Before this month it was 59,750**, and their recruiting parent took another
8,000. The difference is the 15,000 that used to be paid the moment the company
handed over cash.

### Who is affected, and how much

| Agent type | Impact |
|---|---|
| **Collects diligently** | Barely affected — the 10% is untouched and is **79%** of their total |
| **Only acquires, never collects** | Loses most of it — 15,000 a plan disappears |
| **Handles large payouts** | Better off — 1% of 1,000,000 is 10,000, double the old flat 5,000 |

**Nothing is clawed back.** Every shilling already paid stays paid. All of this is
forward-only.

> **This has not yet been announced to agents.** It should be, before anyone
> discovers it from their wallet balance.

---

## 13. Every message we send, in one table

### To the tenant

| When | Message | New? |
|---|---|---|
| While the file is being completed | Intake and progress updates | |
| **Landlord actually paid** | **Welcome — you start tomorrow, here is everything** | **new** |
| Every payment received | What came in, balance, where they stand | |
| Day fully cleared | Confirmation + what they qualify for next | |
| **Part-paid** | **What came in, what is left, carried forward** | |
| Missed a day (7am next day) | It carries forward, here is how to pay | |
| Behind 1, 4, 7, 10 days | How far behind, and the effect on their limit | |
| Occasionally | How to pay Welile directly without the agent | |
| **Plan cancelled** | **Could not be completed — nothing is owed by you** | **new** |

### To the agent

| When | Message | New? |
|---|---|---|
| Landlord bonus earned | Credited to wallet | |
| **Float released by the CFO** | **Money is in your wallet, pay the landlord** | **new** |
| **6 hours later, unpaid** | **Reminder** | **new** |
| **18 hours later, unpaid** | **About 6 hours left, or the plan is cancelled** | **new** |
| **Landlord paid** | **Receipt number, when the tenant starts, your 1%** | **new** |
| Tenant paid directly | Amount, and your commission is already in your wallet | |
| Tenant 3, 6, 9 days behind | Chase this tenant + a task | |
| No collection for 5 days | Warning | |
| No collection for 8 days | Account can be locked | |

### To the landlord

| When | Message |
|---|---|
| Before payout | One-time code to prove it is them |
| Payment confirmed | Full receipt with a permanent number and a public link |
| Payout rejected | Explanation |

### When each sweep runs

| Sweep | How often |
|---|---|
| Daily bill written | **00:05** every night |
| Payment confirmations | every **20 minutes** |
| Missed-payment notices | **07:00** daily |
| Arrears chase | **07:00** daily |
| Agent gone quiet | **09:00** daily |
| Rent Plan transitions | every **10 minutes** |
| Idle float check | every **15 minutes** |

---

## 14. What changed, what is live, what happens Monday

### Live now

| | |
|---|---|
| **Commission corrected** | 15,000 per funded plan removed; parent overrides removed; 1% at landlord-paid is now the only payment at that stage |
| **Duplicate detection** | Live warning as an agent types a landlord or LC1 name |
| **Repayment starts correctly** | The day after the landlord is actually paid — confirmed on 24 live plans |
| **New messages** | Agent float-funded, agent landlord-paid, tenant welcome, tenant cancellation, 6h and 18h nudges |
| **Idle float is visible** | A screen for Landlord Ops and the CFO, with actions |
| **Who may return float** | CFO, Landlord Ops, CTO, Super Admin only |
| **Cancelling unwinds the fees** | Both routes; it never did before |

### From Monday 28 September

The **24-hour recall** begins applying to money released from that moment. Before
then it watches and reports but never acts.

### Still to decide

| | |
|---|---|
| **Telling agents** their earnings changed | Not done. Should be before Monday |
| **27 old idle cases**, UGX 7,990,000 | On the new screen, need a person |
| **14 failed-payout cases**, UGX 4,900,000 | Need Financial Ops |
| 387 plans behind, UGX 47,550,968 | The arrears ladder is running |
| 3,804 requests at the first desk | The real bottleneck |

---

## 15. Where things actually stand today

**Friday 25 September, 14:26.**

| | |
|---|---:|
| Tenants billed today | 482 |
| **Expected today** | **UGX 8,575,337** |
| **Collected against today's bill** | **UGX 510,188** |
| Arrears collected (older bills) | UGX 685,976 |
| **Total cash in** | **UGX 1,196,164** |
| Paid in full | 23 |
| Part-paid | 15 |
| **Paid nothing** | **444** |
| Agents earning commission today | 28 |
| Commission paid today | UGX 129,661 |

### One warning about the coverage number

It is tempting to divide total cash by the bill and call that performance. Today
that gives **13.9%**. The honest figure is **5.9%**.

The difference is that **more than half of today's cash is paying off older
bills**, not today's. Any report that divides one total by the other will read
roughly **twice as good as reality**.

Always quote four numbers, not one ratio: what was expected, what was collected
against it, what came in for older days, and the total.

### For context

| Day | True coverage |
|---|---:|
| 25 Sep (mid-afternoon) | 5.9% |
| 24 Sep | 27.5% |
| 23 Sep | 17.3% |
| 22 Sep | 21.7% |
| 21 Sep | 40.0% |
| 20 Sep | 14.3% |
| 19 Sep | 27.6% |
| 18 Sep | 43.7% |

On a normal weekday about **70% of the day's cash is in by 2pm**. Today is
running at roughly **half yesterday's pace** at the same hour.

---

## Terminology

**Rent Plan**, never "loan". **Supporter** or **Partner**, never "lender".
**Returns**, never "interest". All amounts in Ugandan Shillings.

Every figure in this document was read from production on 25 September 2026.
Collections arrive all day — re-read before quoting any of them.
