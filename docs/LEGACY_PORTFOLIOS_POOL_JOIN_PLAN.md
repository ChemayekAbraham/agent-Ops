# Older portfolios join the Landlord Float Pool: impact and plan

**Date:** 5 October 2026
**Decision being assessed:** older portfolios (created before the pool switch-on on 30 Sep 2026) join the pool fully. Every top-up, every compounding payment and every redemption on them changes the pool, the same as for new portfolios.
**Builds on:**
- [LEGACY_PORTFOLIOS_POOL_IMPACT.md](./LEGACY_PORTFOLIOS_POOL_IMPACT.md) (options A–D). This is option D, applied to all older portfolios.
- [LEGACY_PORTFOLIOS_POOL_CATEGORY_PLAN.md](./LEGACY_PORTFOLIOS_POOL_CATEGORY_PLAN.md) (the tagging run).

**Status:** assessment and plan. Nothing has been built or changed.

---

## 1. In simple terms

From a chosen **join date**, the older portfolios follow the same pool rules as new ones:

| When this happens on an older portfolio | The pool |
|---|---|
| A top-up is applied | **goes up** by the top-up, in that portfolio's group (company-managed or self-support) |
| Returns are compounded into it | **goes up** by the compounded amount |
| The partner redeems part of it | **goes down** by the redeemed amount, up to what that portfolio has in the pool |
| The partner redeems all of it, or it is cancelled | **goes down** by everything that portfolio has in the pool |
| Welile funds a tenant's rent | **goes down**: the rent is paid from the pool first, oldest money first |
| A tenant repays | **goes up** by the rent part (unchanged from today) |

**What is not moved in: the 9.6bn principal the older portfolios hold today.** Each older portfolio joins the pool with a starting balance of **zero**, and its pool balance builds up from its top-ups and compounding from the join date.

The reason is the one in the earlier report: the 9.6bn is not sitting in the bank as spare cash. Welile has about **488m** of spare cash. If the CFO wants a starting amount for the older portfolios, that is option C: one fixed amount, chosen separately.

---

## 2. How big the flows are

Older portfolios, from production:

| Month | Top-ups applied | Compounding | Total into the pool (if joined) | Rent Welile funded |
|---|---|---|---|---|
| July 2026 | 502m | 202m | 704m | 361m |
| August 2026 | 650m | 247m | 897m | 138m |
| September 2026 | 856m | 305m | **1.16bn** | 200m |
| October (1–5) | 149m | 69m | 218m | 42m |

**Redemptions** are rare: 2 in three months (a 5,000 partial and a 9.8m full).

**Today:**
- spare cash (A1): 488.6m;
- pool: about 88.8m;
- withdrawals take about 1.16bn a month out of spare cash.

---

## 3. Effect on the books

Every top-up and compounding payment on an older portfolio moves the same amount **from spare cash into the pool**. Welile's total cash doesn't change; only the split between "spare" and "set aside for landlords" does.

### Estimate for the first month after joining (at September's level)

| | Today | After about 2 weeks | After 1 month |
|---|---|---|---|
| Money going into the pool | — | ~580m | ~1.16bn |
| Rent paid from the pool instead of spare cash | — | ~100m | ~200m |
| **Landlord Float Pool** | 88.8m | ~570m | **~1.05bn** |
| **Spare cash** (if everything else is as today) | 488.6m | **~0** | **~−470m** |
| **Total cash including the pool** | unchanged | unchanged | unchanged |

What this means:
1. **Spare cash on the treasury report goes negative after about two weeks**, and keeps falling by about 0.8–1.0bn a month while top-ups and compounding stay at this level.
2. **Nothing stops working.** Withdrawals, payouts and rent funding don't check the spare-cash figure. The only hard balance rule in the system is that no wallet may go negative, and pool postings never touch a wallet.
3. **The pool grows far beyond what rent needs.** Rent takes about 140–360m a month, so most of what goes in will sit there.
4. **Compounding adds no new cash.** It is Returns kept in the portfolio instead of paid out. About 300m a month would be set aside without any cash coming in.
5. **Finance has to read the right figure:** "total including the pool" for Welile's cash, and spare cash only as "not set aside". Spare cash below zero then means "more is set aside for landlords than Welile has spare", not a loss.

### Accounts involved (all already exist)

| Event | Spare cash (A1) | Pool (A22 company-managed / A21 self-support) | Other accounts |
|---|---|---|---|
| Top-up applied | down | up | none extra. The top-up itself is unchanged |
| Compounding | down | up | none extra |
| Partial / full redemption | up | down | none extra. The payout to the partner is unchanged |
| Rent funded from the pool | — | down | tenant Rent Plan balance up (unchanged) |
| Tenant repays | — | up | unchanged from today |

Every movement is a balanced pair of entries, and each one is mirrored in the pool's own records, as now.

---

## 4. Effect on portfolios

| Item | Effect |
|---|---|
| Portfolio amount, Returns rate, duration, maturity, payout day | none |
| How top-ups and compounding are applied | none. They still add to the portfolio exactly as now. The pool step runs after, alongside |
| Redemptions and their payouts | none. The partner is paid the normal way. The pool step only releases money back to spare cash |
| Renewals | none. Maturity doesn't release anything, because the portfolio may be renewed |
| Locking / splitting | the parent's share is released like a partial redemption. Split children stay outside the pool, as now |
| New internal fields | a **join date** on each older portfolio (§6), alongside the category from tonight's run. Neither is shown to partners |

**Partners see nothing different.** No new screen, message or notice, and no change to their wallet, Returns or dates.

---

## 5. Effect on partners' money and Welile's obligations

| | Effect |
|---|---|
| What Welile owes partners (L2) | unchanged |
| Partner wallets (L1) | unchanged |
| When and how partners are paid | unchanged |
| What it does change | cash behind the older portfolios' new money is ring-fenced for landlords, so it is no longer counted as spare |

---

## 6. What has to be built

The older portfolios carry the permanent "not pool" stamp, and every money step checks it. To include them without weakening that protection, they get a **second, separate marker: the join date.**

The "not pool" stamp keeps its meaning: "principal was not set aside at creation". The join date means "follows the pool rules from this moment". This is the extra marker I said tagging alone did not need. Joining the money flows does need it.

| # | Change | Where |
|---|---|---|
| 1 | Add `pool_joined_at` to portfolios. It is set once by the join run and cannot be changed afterwards, like the stamp | `investor_portfolios` + guard trigger |
| 2 | Add a `landlord_pool_legacy_from` switch row: on/off plus the join time | `treasury_controls` |
| 3 | Top-up and compounding step: allow a portfolio that is "pool" **or** joined, for events at or after its join time | `landlord_pool_reserve_increment`, `trg_landlord_pool_increment_on_ledger` |
| 4 | Redemption / principal-drop step for joined portfolios: release **the smaller of** the drop and that portfolio's pool money, newest first. Release everything on full redemption, cancellation or rejection | `trg_landlord_pool_release_on_change`, `landlord_pool_rebalance` (a new branch; the rule for new portfolios is unchanged) |
| 5 | Report: every portfolio with category, joined yes/no, live principal, and its pool money (in pool / out with tenants / released) | `v_portfolio_pool_category` |
| 6 | Control: a top-up or compounding event on a joined portfolio with no pool entry. Must stay empty | new view, alongside `v_landlord_pool_unreserved` |

**Unchanged:**
- how principal is set aside for new portfolios;
- rent funding (oldest money first);
- tenant repayments;
- cancellations;
- the 24-hour recall.

**Why rule 4 differs:** for a new portfolio, the pool can hold up to its principal. A joined older portfolio has 9.6bn of principal in total but only its post-join top-ups and compounding in the pool. Under the new-portfolio rule a partial redemption would release nothing. Releasing "the smaller of the amount redeemed and what it has in the pool" makes every redemption reduce the pool, which is what was asked.

---

## 7. How it will be switched on

The same safe pattern as tonight's tagging run.

1. **Tonight, 20:00 EAT:** the tagging run, as already planned. It only sets categories and moves no money, so it doesn't depend on any of the above.
2. **Build and dry-run** changes 1–6. Each dry run is rolled back and covers:
   - a top-up;
   - a compounding payment;
   - a partial and a full redemption;
   - a split;
   - rent funded from older-portfolio pool money;
   - a reversal.

   Each must balance, and the books must still match the pool records.
3. **Join run:** a one-time job at **20:00 EAT** on the day you choose.
   - It turns the switch on, then stamps the join time on every older active or locked portfolio.
   - Same safeguards: one transaction, before and after snapshots, no ledger rows written by the run itself, a log per portfolio, and it deletes its own job.
   - Money starts flowing with the **first top-up or compounding payment after 20:00**, at the earliest the 18:00 top-up job the next day.
4. **Next morning:** pool controls (books = pool records, 0 missed, 0 exceptions, money path 17/17), plus a first report of how much went in overnight.
5. **Weekly for the first month:** pool size, spare cash and rent used, so the CFO can see whether a ceiling is needed (§8).

**Undo:** turn the switch off (new events stop going in), then release the joined portfolios' pool money back to spare cash. Everything is recorded per portfolio, so this is exact.

---

## 8. Recommended safeguard: an optional pool ceiling

Because the pool would grow by about 1bn a month while rent uses 140–360m, I recommend a **ceiling setting**, off by default:
- **When off:** every top-up and compounding payment goes in, as decided.
- **When the CFO turns it on** (for example, a 600m ceiling for older-portfolio money): once the older portfolios' pool money reaches the ceiling, new events are still recorded against the portfolio but set no cash aside until rent use brings it back under.

This is a switch for the CFO, not a change to the decision.

---

## 9. Decisions needed

| # | Question |
|---|---|
| J1 | Older portfolios join with a **zero** starting balance (their 9.6bn principal isn't moved in)? |
| J2 | Compounding included as well as top-ups, knowing it adds no new cash (about 300m a month)? |
| J3 | Redemption rule: release the smaller of the amount redeemed and the portfolio's pool money? |
| J4 | Build the optional ceiling switch (off by default)? |
| J5 | Join date: which day's 20:00 EAT run, after the dry runs pass? |
