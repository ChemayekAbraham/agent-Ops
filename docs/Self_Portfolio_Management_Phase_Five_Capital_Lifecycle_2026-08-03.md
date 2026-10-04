# Self Portfolio Management — Phase Five
## What happens to the capital after it is deployed
**Date:** 2026-08-03
**Status:** Design clarification. No build implied by this document.
**Builds on:** Phase Two (§5A, §6), Phase Three (§2, §3, §5.4, §7), Phase Four (§1, §5.4)

---

## 0. The one question this document answers

> *"When a tenant's cycle ends, where does my money go — and why is that not fraud?"*

Answer in one line:

> **The principal never returns to the spendable wallet mid-term. It stays inside the partner's
> commitment, is re-deployed to the next approved plan in the funding queue, and only becomes
> withdrawable when the commitment term itself ends.**

Nothing is hidden, nothing is moved outside the partner's name, and every movement is visible to
the partner on the same screen where they committed. That is why it is recycling, not fraud.

---

## 1. The two clocks — the source of most confusion

| Clock | Starts | Ends | Governs |
|---|---|---|---|
| **Commitment term** | The day the partner commits | Term end date (e.g. 12 months later) | When principal may leave and become withdrawable |
| **Plan cycle** | The day the landlord float is disbursed (Phase Three §5.4) | That plan's end date (e.g. 30 days) | Which tenant the money is working on right now |

A commitment term contains **many** plan cycles. A plan cycle ending is a routine event inside the
term — it is not the term ending, so it does not release principal.

```text
|<--------------------- commitment term (12 months) --------------------->|
| plan 1 | plan 2 | plan 3 | idle | plan 4 | ...            | plan n |    |
                                                                     ^
                                                        term end: principal freed
```

---

## 2. The five states capital can be in

Every shilling a partner has committed is in exactly one state at any moment. This is the vocabulary
the UI must use, unchanged, everywhere.

| State | Meaning | Earning? | Withdrawable? |
|---|---|---|---|
| **Committed — awaiting deployment** | Committed, not yet matched to an approved plan | No (see §4 idle allowance) | No |
| **Deployed — at work** | Funding a live plan; landlord already paid | Yes | No |
| **Returning** | Plan complete, awaiting match to the next plan | Per §4 | No |
| **Released** | Term ended, principal moved back to spendable | No | Yes |
| **Impaired (company-carried)** | Tenant defaulted; company absorbs, partner untouched | Yes, in full | No (until term end, then released in full) |

The only transition that puts money back in the spendable wallet is **→ Released**, and it only
fires at term end or on an approved early-exit (§6).

---

## 3. The moment a plan completes — step by step

1. **Plan reaches its end date** (or the tenant finishes early — Phase Three §2, row 4).
2. **The month already running is paid in full.** No proration, no clawback, regardless of how the
   tenant behaved.
3. **The completed funding line is closed** and stamped with its dates, principal, and total returns
   paid. It stays permanently in the partner's history — a closed line is never deleted.
4. **Principal moves to `Returning`**, still inside the commitment, still in the partner's name.
5. **First refusal**: if *that* tenant has posted a new plan, the partner gets 24 hours to take it
   (Phase Two §6).
6. **Automatic redeployment** (the default): the principal is matched to the **front of the approved
   funding queue** — whoever is next, not necessarily the same tenant (Phase Three §3).
7. **A new funding line opens**, badged *Self-managed*, showing the new tenant, amount, dates and the
   fact that it was funded by recycled capital from the closed line. The partner is notified.
8. **Both clocks behave as designed**: the new plan cycle starts when that landlord is paid; the
   commitment term keeps running from its original start date and is **not extended**.

If the partner is on **manual** selection and does nothing, the principal sits in `Returning` and the
capped paid-idle allowance applies (§4).

---

## 4. Idle capital between plans

Recycling is rarely instant — there can be a gap between one plan closing and the next being matched.

- The gap is **paid**, at the partner's agreed rate, up to the **cap set in Phase Two §5A**.
- Beyond the cap, idle days are **unpaid**, and the partner is told plainly, in advance, on the
  portfolio screen and by notification.
- The reason for the cap is honesty about where the money comes from: idle capital earns the company
  nothing, so an uncapped idle payment is the company paying returns out of nowhere.
- Idle days **never** shorten or extend the commitment term.

---

## 5. Why this is not fraud — the five guarantees

Each of these is a build commitment, not a description of intent:

1. **The money never leaves the partner's name.** Recycled principal stays booked as the partner's
   committed capital. It is never re-tagged to a company operating account.
2. **Every movement is ledger-posted and person-bound.** A closed line and its successor line are
   both visible, dated and reconcilable by the partner and by finance.
3. **The partner is notified on every redeployment**, with the new tenant, amount and dates.
4. **Returns are unaffected by recycling.** The rate is on committed principal, so a recycled
   shilling earns exactly what it earned before — recycling moves principal, it does not compound
   (Phase Four §5.4).
5. **The partner can stop the behaviour.** Switching to manual selection, or declining to re-deploy,
   is always available. Automatic is a default, never a lock.

The fraud concern arises only if principal were to appear in the spendable wallet mid-term and be
withdrawn while still shown as at work — i.e. the same shilling counted twice. Keeping principal out
of the spendable bucket until `Released` is precisely what prevents that.

---

## 6. Term end — the exit

At the commitment term end date the partner chooses, and is prompted 30 days in advance:

| Choice | What happens |
|---|---|
| **Withdraw** | Recycling stops. As each live plan completes, its principal moves to `Released` and lands in the spendable wallet as person-bound money, withdrawable under normal limits. |
| **Renew** | A fresh term starts; principal continues recycling with no interruption and no return to the wallet. |
| **Partial** | Part released, part renewed. The released part follows the Withdraw path, the rest continues. |

Two hard rules:

- **Principal is released only as live plans complete.** A partner cannot pull principal out of the
  middle of a live plan — the landlord has already been paid.
- **No new deployment is started after a Withdraw election**, so the wind-down is bounded by the
  longest live plan, and the partner is shown that exact date.

Early exit before term end follows the existing **90-day notice** rule already governing partner
withdrawals; returns stop accruing for the noticed amount over that period.

---

## 7. What the partner must see on screen

A partner should never have to ask where their money is. The portfolio view shows:

- The five state totals from §2, as a single stacked figure that sums exactly to the commitment.
- The commitment term start and end date, and days remaining.
- Every funding line — open and closed — with tenant, principal, dates, returns paid, and whether it
  was newly funded or recycled.
- The next return date and amount, badged *Self-managed*.
- Idle days used against the Phase Two §5A cap, when any exist.

---

## 8. Deliberately still out of scope

- The line-by-line monthly and annual partner statement.
- Finance-side reporting views for committed, idle, at-risk and impaired capital.
- Recovery mechanics after a default beyond "the company carries it".
- Whether managed partners may move capital into self-managed at term end.

---

## 9. The detailed money trail — answering "where does the amount actually go?"

This section replaces the one-line answer in §0 with the full mechanics. It follows a single
UGX 300,000 commitment from the day the partner commits to the day it is paid back out.

### 9.1 First — what "the tenant's repayment" is actually made of

A tenant on a rent plan does not repay one lump. Each daily/weekly installment they pay is split by
the ledger into two economically different things:

| Component | Belongs to | Where it goes |
|---|---|---|
| **Principal portion** — the rent capital that was advanced | The partner's committed capital | Back into the commitment (never the spendable wallet mid-term) |
| **Fee/margin portion** — the platform charge on top of rent | The company | Company revenue, out of which the partner's fixed return is paid |

So the tenant's repayment stream is **not** the partner's return. The partner's return is a fixed rate
on committed principal, paid monthly by the company (Phase Four §5.4). The tenant's principal
repayments only restore the capital base. This is why a tenant paying late, early, or defaulting does
not change what the partner is paid — the two flows are deliberately decoupled.

### 9.2 Where the principal physically sits at each stage

"Where does it go" has a literal answer at every moment. There are only four places money can be, and
each state in §2 maps to exactly one of them:

| State (§2) | Physical location of the money | Who can touch it |
|---|---|---|
| Committed — awaiting deployment | Company float, ring-fenced and tagged to the partner's commitment ID | Nobody. Not the partner (locked), not operations (tagged) |
| Deployed — at work | Already left the platform: it is in the **landlord's** hands as paid-forward rent | Nobody — it is spent by design |
| Returning | Back in company float, still tagged to the same commitment ID | Nobody; awaiting the matching engine |
| Released | The partner's own spendable wallet bucket | The partner, under normal withdrawal limits |
| Impaired | Written against the company's loss account, commitment balance left whole | Nobody; partner is made whole at term end |

The critical point: **`Deployed` money is genuinely gone from the platform.** It was handed to a
landlord to cover a tenant's rent for that cycle. That is the whole product. There is no version of
this where deployed principal could also be sitting in a wallet — it would mean the landlord was
never paid.

### 9.3 Worked example — one commitment, three tenant cycles

Partner commits **UGX 300,000** for a **12-month** term on 1 Jan. Assume a 30-day plan cycle and a
monthly return rate agreed at commitment.

| Date | Event | Deployed | Returning / idle | Released | Partner's commitment balance |
|---|---|---|---|---|---|
| 1 Jan | Commitment accepted, capital ring-fenced | 0 | 300,000 | 0 | 300,000 |
| 4 Jan | Matched to Tenant A; **landlord A paid 300,000** | 300,000 | 0 | 0 | 300,000 |
| 1 Feb | Month 1 return paid to spendable wallet | 300,000 | 0 | 0 | 300,000 |
| 3 Feb | Tenant A's plan closes; principal recovered from tenant repayments | 0 | 300,000 | 0 | 300,000 |
| 3 Feb | Tenant A offered first refusal (24h) — declines | 0 | 300,000 | 0 | 300,000 |
| 5 Feb | Matched to Tenant B; **landlord B paid 300,000** | 300,000 | 0 | 0 | 300,000 |
| … | Cycles continue; return paid every month regardless of which tenant | 300,000 | 0 | 0 | 300,000 |
| 1 Dec | 30-day term-end prompt: partner elects **Withdraw** | 300,000 | 0 | 0 | 300,000 |
| 4 Jan+1 | Final plan completes; principal moves to Released | 0 | 0 | 300,000 | 0 |
| 4 Jan+1 | Partner withdraws 300,000 from spendable wallet | 0 | 0 | 0 | 0 |

Notice what never happens: the 300,000 is never in two rows at once, and it never enters the
withdrawable bucket while a landlord is holding it.

### 9.4 What if the tenant repays less than the principal advanced?

This is the case partners actually worry about. Three outcomes, all resolved without touching the
partner:

| Scenario | Effect on the commitment | Who absorbs it |
|---|---|---|
| Tenant repays in full | Principal fully restored to `Returning` and recycled | Nobody — normal path |
| Tenant repays partially, plan closes | Commitment balance is **still shown and honoured in full**; the shortfall is booked to `Impaired (company-carried)` and the company tops the recycling pool back to full principal | The company |
| Tenant defaults outright | Same as above, for the whole principal | The company |

The partner's return continues on the **full** committed amount in all three rows, and at term end the
**full** committed amount is released. That is the meaning of "self-managed selection, company-carried
default risk" from Phase Three.

### 9.5 Why the money cannot simply be returned each cycle

If principal were released to the spendable wallet after every 30-day plan, the product would break in
four measurable ways:

1. **The partner would be paid a monthly rate on capital that is no longer at work.** That is the
   company paying returns out of its own pocket for money sitting in a wallet — the exact thing §4
   caps for idle days.
2. **The funding queue would starve.** Approved tenants are matched from recycled capital; releasing it
   every cycle means a 12-month commitment funds one tenant, not many.
3. **Double-counting risk.** Money in a spendable wallet is withdrawable within minutes, while a
   landlord may still be mid-cycle on the same shilling. That is the fraud vector, not the recycling.
4. **The term would be meaningless.** A 12-month commitment with monthly release is a 30-day product
   priced as a 12-month one.

### 9.6 The exact answer, restated precisely

When a tenant's repayment duration ends, the principal that supported that tenant:

1. is **collected back from the tenant's repayments** into company float, still carrying the partner's
   commitment tag;
2. is topped up by the **company** if the tenant under-repaid, so the commitment balance stays whole;
3. sits in **`Returning`** — visible on the partner's screen as a distinct figure, not merged into any
   other number — while the matching engine works;
4. is **offered to the same tenant first** for 24 hours if that tenant has posted a new plan;
5. is then **paid out to the next approved plan's landlord**, opening a new funding line badged as
   recycled, with a notification to the partner;
6. **only leaves this loop at commitment term end** (or an approved 90-day-notice early exit), at which
   point it moves to `Released` and appears in the partner's spendable wallet.

At no point in steps 1–5 does the amount become withdrawable, and at no point does it stop belonging
to the partner.
