# Moving existing partner portfolios into the Landlord Float Pool: impact assessment

**Date:** 5 October 2026
**Data:** live production, queried on the day. Figures move by the minute as repayments post.
**Scope:** the portfolios that were already running before the pool was switched on (30 Sep 2026, 09:29 UTC). Today they are deliberately outside the pool (see [LANDLORD_FLOAT_POOL_GUIDE.md](./LANDLORD_FLOAT_POOL_GUIDE.md) §11).
**Nothing has been changed.** This is an assessment only.

---

## 1. The short answer

- **What partners would see:** nothing changes for them. Their portfolio amount, Returns, payout dates, maturity dates and wallet balances stay the same, whichever option is chosen. Pool postings never touch a wallet.
- **What would change** is Welile's own books: how much cash is reported as **free** and how much as **set aside for landlords**.
- **The constraint:** the older portfolios hold **UGX 9.59 billion**, but Welile's free cash is **UGX 488.6 million**. The pool can only set aside cash that actually exists. Moving the full principal in is not possible: it would show free cash at about **−9.1 billion**.
- **Recommendation:**
  1. Bring the older portfolios in **by category only** (labelled company-managed, attributed, reported), with no cash moved.
  2. If more cash is to be set aside, add it as **one fixed amount chosen by the CFO**, not portfolio by portfolio.
  3. Do **not** switch on top-ups and compounding for older portfolios without a cap: they would set aside about **1.17 billion a month**, more than twice today's free cash.

---

## 2. What is running today

### Older portfolios (before the switch-on)

| Type | Portfolios | Partners | Principal (UGX) |
|---|---|---|---|
| Company-managed (nothing attached) | 1,348 | 911 | 9,586,230,563 |
| Self-support, tenant attached | 1 | 1 | 600,000 |
| Self-support, house attached | 1 | 1 | 100,000 |
| **Total active** | **1,350** | | **9,586,930,563** |

Also outside the pool:
- 5 locked portfolios (4.12m), one of them a split child;
- 4 cancelled portfolios and 1 redeemed portfolio, which are not relevant.

**How they earn:**

| Returns mode | Portfolios | Principal (UGX) |
|---|---|---|
| Paid out monthly | 976 | 7.39bn |
| Compounding (Returns added back to the portfolio) | 370 | 2.19bn |
| Other (simple, monthly) | 4 | 12.5m |

**Coming up:**
- 67 portfolios (708m) mature in the next 90 days;
- 5 have a future-dated creation date.

### New portfolios (since the switch-on), for comparison

- 41 active (114.6m) are in the pool.
- 17 are waiting for approval or partner details. They enter the pool when they become active.

### Welile's cash position today

| Line | UGX |
|---|---|
| Free cash (A1) | 488,628,205 |
| Landlord Float Pool, company-managed (A22) | 88,775,653 |
| Landlord Float Pool, self-support (A21) | 50,000 |
| Cash received, not yet banked (A5) | 1,250,451,804 |
| Tenant Rent Plan balances owed (A3) | 483,760,253 |

The pool's own records still match the books to the shilling on both compartments. There are no failed pool steps and no missed portfolios.

### Money moving each month (last 30 days)

| Flow | UGX |
|---|---|
| Wallet withdrawals paid out of free cash | 1.16bn |
| Returns paid or credited to partners | 1.23bn |
| Top-ups applied to portfolios: **all of them to older portfolios** | 871m |
| Compounded Returns added back: **all of them to older portfolios** | 296m |
| Rent paid to landlords for tenants funded by Welile | 70m |
| Pool money used for that rent | 38m |

---

## 3. The options

### Option A: move the full principal in (backfill)

Set aside 9.59bn from free cash, one pool record per portfolio.

- **Books:** free cash would show about **−9.1bn**. The money does not exist as free cash: most of the partners' capital is already working, for example out with tenants, in transit or already paid out.
- **Treasury report:** it would show a deficit that is not new. It would just show an old gap under a new heading.
- **Rent funding:** no improvement. The pool already holds 88.8m, which covers more than a month of Welile-funded rent (70m a month).
- **Verdict:** **not possible as a cash ring-fence. Not recommended.**

### Option B: bring them in by category only (recommended first step)

Label every older portfolio as **company-managed**, or as self-support for the two that have a tenant or house. They then appear in pool reports under a **"legacy"** label. No cash moves.

- **Books:** no change. Free cash and the pool stay as they are.
- **Partners:** no change.
- **What it gives:**
  - one place where every portfolio, old and new, is reported by category;
  - a correct count of how much partner capital each compartment stands behind;
  - a basis for Option C if wanted.
- **Care needed:**
  - The "pool / not pool" stamp is locked by design and must stay locked. Older portfolios get a **separate legacy flag** instead.
  - The automatic steps must **ignore** that flag, so that redeeming an older portfolio does not try to release money it never put in. It would release nothing anyway, because the release is limited to what is actually in the pool, but it should be explicit.
- **Effort:** small. One column, one report view, and no change to how money moves.

### Option C: set aside a fixed amount chosen by the CFO

On top of Option B, the CFO chooses an amount, for example "set aside 100m for landlords". It is posted once, as one company-managed legacy entry, and shared across the older portfolios for reporting.

- **Books:** free cash goes down by the chosen amount and the pool goes up by the same amount. The total is unchanged.
- **Partners:** no change.
- **Why one entry and not 1,350:**
  - The cash cannot be traced to individual older portfolios, so per-portfolio entries would be a guess. The rule so far is that nothing is guessed.
  - One entry is easy to check, top up or release.
- **Risk:** this is a judgement call on liquidity. Withdrawals take about **1.16bn a month** from free cash, and free cash is 488.6m. Nothing in the system stops a withdrawal when free cash is low; the report would simply show free cash as negative. Any amount set aside should leave room for at least a few weeks of withdrawals.

### Option D: top-ups and compounding on older portfolios go into the pool from now on

The same rule as for new portfolios, applied to older ones from a second switch-on date.

- **Size:** about **871m in top-ups + 296m in compounding = 1.17bn a month**.
- **Books:** the pool only gives back about 70m a month through rent funding. **Free cash would go negative within about two to three weeks.**
- **Compounding is not new cash.** It is Returns that Welile would otherwise pay out. Setting it aside takes it out of free cash without any cash arriving.
- **Verdict:** **not recommended without a cap.** If wanted, consider:
  - top-ups only (real money that arrived), with a monthly ceiling set by the CFO;
  - compounding left out.

---

## 4. Effects on running portfolios, item by item

| Area | Effect under B | Under C | Under D |
|---|---|---|---|
| Portfolio amount, Returns, payout dates, maturity | none | none | none |
| Partner wallets | none | none | none |
| Monthly Returns payouts | none | none | none |
| Redemption or maturity payouts | none. The partner is paid the normal way | the legacy entry shrinks as portfolios close (release back to free cash) | per-portfolio release of top-up / compound money |
| Top-ups being applied (57.7m waiting now) | none | none | each one sets cash aside |
| Compounding (370 portfolios) | none | none | each run sets cash aside |
| Splitting or locking a portfolio | none | none | parent's top-up money rebalanced |
| Free cash on the treasury report | unchanged | down by the chosen amount | down by about 1.17bn a month |
| Which money pays a tenant's rent | unchanged | legacy money is used first (it is the oldest) | same |
| Pool exceptions queue | none | none | about 650 more automatic steps a month that could fail |

### Special cases among the older portfolios

| Case | What happens |
|---|---|
| **1 older self-support tenant (600k)** | That tenant was funded the old way, with no pool record, so their repayments cannot be traced back to this portfolio. Under B it is labelled self-support for reporting only. |
| **1 older self-support house (100k)** | No money is set aside for it. If a tenant takes the house, it is funded the old way. Under B it is labelled only. |
| **5 future-dated portfolios** | Already handled. They are treated as older because of the stamp, whatever their date says. |
| **5 locked / split portfolios** | Leave them out. Split children are never in the pool. |
| **67 maturing in 90 days (708m)** | Under B/C, nothing extra happens at maturity. Under D, their top-up and compound money is released when they are redeemed. |

---

## 5. Recommendation and order of work

1. **Option B now:** legacy flag, category label and reports. No cash moves, so it is safe for running portfolios.
2. **Decide Option C separately:** the CFO picks an amount, if any, with today's free cash (488.6m) and monthly withdrawals (1.16bn) in view.
3. **Do not run Option D as it stands.** If forward flows are wanted, do top-ups only, with a monthly ceiling.
4. Before and after each step, run the pool checks in [LANDLORD_FLOAT_POOL_TECHNICAL.md](./LANDLORD_FLOAT_POOL_TECHNICAL.md) §10. The books must still match the pool records, and nothing may be missed or failed.

## 6. Decisions needed

| # | Question |
|---|---|
| L1 | Go ahead with Option B (label only, no cash)? |
| L2 | Set aside a fixed amount for the older portfolios (Option C)? If yes, how much? |
| L3 | Should top-ups on older portfolios go into the pool from now on? If yes, with what monthly ceiling? Leave compounding out? |
| L4 | Label the two older self-support portfolios (600k tenant, 100k house) as self-support, or leave them as they are? |
