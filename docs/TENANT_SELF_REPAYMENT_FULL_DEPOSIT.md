# Tenant self-repayment: take the whole deposit, not just today's amount

Status: IMPLEMENTED 21 Sep 2026 — `settle_tenant_rent_from_deposit()` now applies the
whole deposit and sends the upgraded messages described below.


## 1. What happens today

When a tenant deposits money themselves, `settle_tenant_rent_from_deposit()` runs and
decides how much of the deposit to apply to the Rent Plan:

```
applied = LEAST( deposit amount,
                 today's remaining daily amount,   <-- the cap we want to remove
                 tenant's withdrawable balance )
```

So a tenant whose daily amount is UGX 4,400 who deposits UGX 20,000 has only
**UGX 4,400** applied to rent. The remaining UGX 15,600 sits in their wallet
balance, and the Rent Plan balance barely moves.

Worse, if an agent already collected that day, the whole deposit is refused with
the reason `daily_amount_already_paid` — the tenant's money is simply not used.

## 2. What we change

Paying ahead is already supported: every collection rebuilds the day-by-day
settlement record (`rent_day_settlements`) first-in-first-out, so money above
today's amount automatically covers tomorrow, the day after, and so on. There is
therefore no reason to cap at one day.

New rule, one line of logic:

```
applied = LEAST( deposit amount,
                 total rent outstanding,
                 tenant's withdrawable balance )
```

Consequences:

| Case | Today | After the change |
|---|---|---|
| Daily 4,400, deposit 20,000, balance 480,000 | 4,400 applied, 15,600 idle in wallet | 20,000 applied, ~4 days + part of a 5th covered ahead |
| Agent already collected today | refused, nothing applied | full deposit applied to the days ahead |
| Deposit 500,000, outstanding 480,000 | 4,400 applied | 480,000 applied, plan completed, 20,000 stays in wallet |
| Wallet balance lower than deposit | unchanged behaviour | still limited by the real balance — never overdraws |

Everything else stays exactly as it is: same money movement (tenant wallet →
rent receivable → landlord waterfall → agent commission), same commission rates
and 8/2 split, same one-time-only protection per deposit, same audit records.
Only the *amount* chosen changes.

The refusal reason `daily_amount_already_paid` disappears; the only remaining
refusals are "plan already cleared" and "no balance to apply".

### Effects worth knowing before approving

- The agent's commission on a self-payment is now calculated on the full deposit,
  so an agent can earn several days of commission at once — this is the correct
  outcome, since several days of rent were genuinely paid.
- A tenant's daily collection target drops to zero for every day already covered
  ahead, so agents will correctly stop chasing them for those days.
- Plans can now be completed by a single large tenant deposit.

### 2b. When the tenant deposits LESS than the expected daily amount

This is the common case and it is treated as a genuine part-payment, never as a
failure:

```
applied = LEAST( deposit amount, total rent outstanding, wallet balance )
```

The same one rule covers it — there is no minimum. A tenant whose daily amount is
UGX 4,400 who deposits UGX 2,000 has the full UGX 2,000 applied to the Rent Plan.

What the system then does:

| Step | Behaviour on a short deposit |
|---|---|
| Amount applied | The whole deposit (UGX 2,000), not rounded, not refused |
| Day record | The day-by-day settlement is rebuilt first-in-first-out: today shows UGX 2,000 paid and UGX 2,400 still due — the day stays **open** |
| Arrears | Derived, never stored. Today's shortfall becomes arrears only once the day passes unpaid; the next payment (tenant or agent) clears the oldest open day first |
| Agent's list | The tenant **stays** on the agent's collection list for today, with the expected amount reduced to the UGX 2,400 remaining |
| Agent commission | Earned on UGX 2,000 only — commission always follows money actually received |
| Rent plan balance | Falls by UGX 2,000; no penalty, no fee, no status change |
| A second deposit the same day | Accepted and applied the same way; several small deposits can complete the day |

So short deposits never block, never overdraw and never double-count: the day
closes when the total received for it reaches the expected amount, whoever paid
it in.


## 3. The SMS problem

Current tenant message:

> Hi Ronald, we received UGX 20,000 and applied UGX 4,400 to your rent.
> Remaining today UGX 0. Remaining to complete UGX 480,000.
> UGX 15,600 stays in your wallet balance. Thank you.

It is unclear because it mixes four different numbers with no framing, talks
about "remaining today" which stops being meaningful once days are paid ahead,
and never tells the tenant the one thing they care about: **which day are they
now paid up to.**

Agent message has the same problem — it names a commission with no mention of
how many days were covered or where the money came from.

## 4. Upgraded SMS templates

### 4a. Tenant — full deposit applied, days covered ahead

```
Welile: Rent payment received, Ronald.
Paid: UGX 20,000
Covers 4 days - you are paid up to 25 Sep 2026.
Rent balance: UGX 460,000
Ref TSP-4f2a9c11. Thank you.
```

### 4b. Tenant — part of the deposit left in the wallet (plan completed or balance smaller than deposit)

```
Welile: Rent payment received, Ronald.
Paid: UGX 480,000 - your Rent Plan is now fully paid. Congratulations.
UGX 20,000 stays in your Welile wallet.
Ref TSP-4f2a9c11. Thank you.
```

### 4c. Tenant — deposit larger than the wallet balance available

```
Welile: Rent payment received, Ronald.
Paid: UGX 12,000 from your wallet balance.
Covers 2 days - you are paid up to 23 Sep 2026.
Rent balance: UGX 468,000
Ref TSP-4f2a9c11.
```

### 4d. Tenant — deposit smaller than today's expected amount (part-payment)

```
Welile: Rent payment received, Ronald.
Paid: UGX 2,000
Still due today: UGX 2,400 for 21 Sep 2026.
Rent balance: UGX 478,000
Ref TSP-4f2a9c11. Thank you.
```

### 4e. Agent — full deposit, days covered ahead

```
Welile: Ronald Musana paid his own rent.
Received: UGX 20,000 (covers 4 days, paid up to 25 Sep 2026)
Your commission: UGX 1,600 - already in your withdrawable balance.
His rent balance: UGX 460,000. No collection needed from him until 26 Sep.
```

### 4f. Agent — tenant part-paid, collection still open

```
Welile: Ronald Musana part-paid his own rent.
Received: UGX 2,000 of UGX 4,400 for today.
Still to collect today: UGX 2,400.
Your commission: UGX 200 - already in your withdrawable balance.
His rent balance: UGX 478,000.
```


Rules applied to all templates:

- One fact per line, largest first — amount paid, then cover, then balance.
- Always "Rent Plan", "Returns", "Supporter"; never "loan", "lender", "interest".
- Amounts always `UGX 20,000` — never USh, Shs or /=.
- "Paid up to" date and "covers N days" are read from the day-by-day settlement
  record that the payment itself rebuilds, so the message can never disagree with
  the plan.
- The `TSP-` reference is kept so support can trace any message to one payment.
- No "remaining today" line when days are paid ahead. It appears only in the
  part-payment message, as "Still due today", because there the day is genuinely
  still open and the tenant needs to know the exact gap.


## 5. What gets touched when implemented

- `settle_tenant_rent_from_deposit()` — the amount rule (section 2) and the two
  message bodies it queues (section 4). A new migration; no history rewritten.
- Nothing in the app front end changes: the tenant and agent screens already read
  the outstanding balance and the covered days from the same records.
- The SMS sender (`tenant-self-repayment-notices`) is unchanged — it only sends
  what the settlement queues.

## 6. Check after release

- A test tenant deposit above the daily amount shows several days covered ahead.
- The agent's daily collection list stops showing that tenant for covered days.
- Both SMS messages arrive, read cleanly, and their figures match the screens.
