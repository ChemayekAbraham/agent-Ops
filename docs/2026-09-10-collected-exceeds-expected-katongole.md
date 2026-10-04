# Why today shows 6M collected against a 4.70M bill — and why Katongole reads 2652%

**As at 2026-09-10, 08:54 EAT.** Collections arrive continuously; re-derive before quoting any figure here.

Short answer: **the 6M vs 4.70M is not a bug** — it is the bill-versus-receipts trap, and the two numbers were never comparable. **Katongole's percentage is a real bug**: the eligibility gate divides by today's bill but does not cap the numerator, so a large pre-payment reads as thousands of percent and unlocks new lending.

---

## 1. The fleet numbers, and what they actually mean

| Figure | Amount |
| --- | ---: |
| Pinned bill for today (224 plans) | **4,700,079** |
| Total cash in the door (15 collections) | **6,026,262** |
| — of which landed on plans billed today | 4,766,602 |
| — of which landed on plans **not billed today** | 1,259,660 |
| **Actually due today and paid** | **206,602** |
| Money paid ahead, sitting on no day yet | **5,819,660** |
| True coverage of today's bill | **4.4%** |

The 6,026,262 and the 4,700,079 measure different things:

- **4,700,079** is the *bill*: what 224 plans owe **today**, pinned at 00:05 and frozen.
- **6,026,262** is the *receipt book*: every shilling that came in today, whatever day it was for.

Almost all of today's cash is money that was **not due today**. Only **206,602** of the 6M answers "did today's tenants pay today's rent". Dividing 6,026,262 by 4,700,079 gives 128%, which would say the network over-collected — while the honest reading is that it has collected **4.4%** of today's obligations so far this morning.

**Cross-check:** the new arrears engine independently attributed exactly **206,602** to today. That figure was computed two different ways — the engine's day-by-day attribution and a capped bill join — and they agree to the shilling. The engine is working.

---

## 2. Katongole James: what the ten records actually were

Ten collections in **eight minutes** (07:29:39 → 07:37:30), across **three** tenants:

| Time | Tenant | Collected | Billed today | Landed on a day | Held ahead |
| --- | --- | ---: | ---: | ---: | ---: |
| 07:29:39 | Kalule Brian | 58,700 | — (weekly, not due) | 0 | 58,700 |
| 07:30:21 | Namakula Saidat | 60,000 | 89,334 | **60,000** | 0 |
| 07:31:02 | twesige agnes | 200,000 | 89,334 | **89,334** | 110,666 |
| 07:31:49 | Namakula Saidat | 89,334 | 89,334 | **29,334** | 60,000 |
| 07:32:25 | twesige agnes | 89,334 | 89,334 | 0 | 89,334 |
| 07:33:04 | Kalule Brian | 600,000 | — | 0 | 600,000 |
| 07:33:55 | twesige agnes | 1,000,000 | 89,334 | 0 | 1,000,000 |
| 07:35:33 | Namakula Saidat | 2,000,000 | 89,334 | 0 | 2,000,000 |
| 07:36:28 | twesige agnes | 1,300,000 | 89,334 | 0 | 1,300,000 |
| 07:37:30 | Kalule Brian | 500,000 | — | 0 | 500,000 |
| | **Total** | **5,897,368** | **178,668** | **178,668** | **5,718,700** |

His actual obligation this morning was **178,668** — two daily tenants at 89,334 each. Kalule Brian is on a weekly plan that is not due today, so nothing was billed for him at all.

**He collected exactly 178,668 against it — 100.0% of his real bill.** Everything above that, **5,718,700**, is pre-payment: money for days that have not happened yet. The engine parked it correctly rather than counting it as today's performance.

The waterfall handled the partial case properly along the way: Namakula Saidat's first 60,000 left the day 29,334 short, and the next payment's first 29,334 closed it before the remainder was banked.

---

## 3. Where the bug is

The eligibility view produces **two** percentages for the same day:

| Measure | Value | How it is computed |
| --- | ---: | --- |
| `today_pct` (capped) | **100.0%** | each tenant capped at what they owed |
| `raw_today_pct` (uncapped) | **3300.7%** | all cash ÷ today's bill |

The posting gate takes `GREATEST(effective_pct, raw_today_pct, raw_yesterday_pct)`, so **the uncapped figure wins** — and the tile shows a number in the thousands.

```
5,897,368 ÷ 178,668 = 3300.7%
```

(The 2652% seen earlier in the day was the same calculation on 4,738,668, before the last two collections landed.)

**Why this matters beyond a silly-looking number.** The gate exists to ask *"is this agent servicing today's book well enough to justify lending more?"* An uncapped ratio lets a single lump sum answer that question for a whole book. One tenant pre-paying two million unlocks unlimited new Rent Plan postings, regardless of whether the agent's other tenants were collected from at all.

This directly contradicts the rule we already agreed for arrears: **money that is not for today should not score against today.** The capped figure already implements that correctly — it reads exactly 100.0%. It is simply not the one the gate uses.

The fix is one line in principle: score the gate on the capped figure, not the uncapped one. That needs an impact measurement across all agents first, because some agents currently pass only because of the uncapped number.

---

## 4. Commission is being paid on money that is not yet due

Katongole earned **589,736.80** in commission today — 10% of the full 5,897,368, including the 5,718,700 that has not fallen due.

That is how the commission rule is written (10% of the amount collected), and the money genuinely left his float, so it is not fraud or an error. But it is worth a deliberate decision: pre-payment currently pays commission today at the full rate, rather than as each day is actually settled.

---

## 5. Is the money real? Yes

| | |
| --- | ---: |
| Float at start of day (derived) | ~11,794,736 |
| Topped up today | 178,700 |
| Spent on collections today | 5,897,368 |
| Float now | 6,076,068 |

The float control did its job — he could not have recorded more than he held, and he is out of pocket the full 5,897,368 until those tenants repay him. Three tenants went from largely unpaid to nearly cleared:

| Tenant | Total plan | Collected today | Outstanding now |
| --- | ---: | ---: | ---: |
| twesige agnes | 2,680,000 | 2,589,334 | 29,889 |
| Namakula Saidat | 2,680,000 | 2,149,334 | 460,666 |
| Kalule Brian | 1,747,223 | 1,158,700 | 541,300 |

---

## 6. One thing worth checking with Agent Ops

Katongole has **40 Rent Plans**, of which **37 are already `completed`** and only 3 are live. The completed ones are the same seven tenants recycled over and over — Ndagire Sumayiyah, Kato Daniel, Zeliida Nanyondo, Serwadda John, twesige agnes, Namakula Saidat, Kalule Brian — with repeated plans of 2,680,000, 3,345,000 and 4,010,000.

That pattern, plus ten collections in eight minutes clearing three plans at once, does not look like ordinary field collection. It may be a demo or test account, or a legitimate bulk settlement. **It is worth confirming what this account is before treating its numbers as field performance**, because it is large enough to distort any network-level figure it appears in.

---

## 7. The 4,112,318 "balance" — not reproduced

The Performance tab reports, for 10 Sep: *10 records, UGX 5,897,368 collected, UGX 4,112,318 balance.*

The collected figure is exactly right. **The balance figure I could not reproduce.** His three live plans' outstanding sums to **1,031,855**, not 4,112,318, and it is not the start-of-day outstanding either (that was ~6,929,223). `get_agent_collection_records` returned an empty array for today's window, so it is not the source.

I am not going to guess at what basis produces 4,112,318. Note that `AgentPerformanceReport` is on our own list of surfaces that were **not** corrected when the expected-vs-collected split was fixed elsewhere, so its basis needs to be established rather than assumed.

---

## 8. Summary

| Question | Answer |
| --- | --- |
| Why is collected (6M) above expected (4.70M)? | Different populations. 5,819,660 is pre-payment for future days and 1,259,660 is on plans with no bill today. Only 206,602 was due today. |
| Is that a bug? | **No.** Expected is the frozen daily bill; collected is all cash in. They are not a ratio. |
| Why does Katongole read 2652% / 3300%? | The gate uses an **uncapped** ratio: 5,897,368 ÷ 178,668. The capped figure is exactly 100.0%. |
| Is *that* a bug? | **Yes.** A lump-sum pre-payment unlocks the posting gate without the agent servicing their book. |
| Did the arrears engine misbehave? | **No.** It attributed 178,668 to today and parked 5,718,700 as paid-ahead — exactly as designed, on its first live day. |
| Where's the money? | Real. It left his float; he holds 6,076,068 and is owed it back by three tenants. |

**Recommended next step:** measure, across all agents, what changes if the gate scores on the capped figure instead of the uncapped one — then apply it. That is the same shape of change as the two applied yesterday, and it closes the last route by which money that is not due today can unlock new lending.

Nothing was changed to produce this document.
