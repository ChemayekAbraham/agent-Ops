# Older portfolios join the Landlord Float Pool: impact and plan

**Date:** 5 October 2026
**Decision being assessed:** older portfolios (created before the pool switch-on on 30 Sep 2026) join the pool fully. Every top-up, every compounding payment and every redemption on them changes the pool, the same as for new portfolios.
**Builds on:**
- [LEGACY_PORTFOLIOS_POOL_IMPACT.md](./LEGACY_PORTFOLIOS_POOL_IMPACT.md) (options A–D). This is option D, applied to all older portfolios.
- [LEGACY_PORTFOLIOS_POOL_CATEGORY_PLAN.md](./LEGACY_PORTFOLIOS_POOL_CATEGORY_PLAN.md) (the tagging run).

**Status:** **built and scheduled** (6 Oct 2026). J1–J5 approved as recommended. See §10, "As built".

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

---

## 10. As built (6 October 2026)

### Decisions applied

| # | Decision |
|---|---|
| J1 | Older portfolios join with a **zero** starting balance. Their principal is not moved in |
| J2 | **Top-ups and compounding** both go into the pool from the join time |
| J3 | A principal drop releases **the smaller of the drop and that portfolio's pool money**, newest first. Closing (redeemed / cancelled / rejected) releases everything still in the pool |
| J4 | Ceiling switch built, **off** |
| J5 | Join run: **7 Oct 2026, 20:00 EAT** |

### Migration `20261006160000_landlord_pool_legacy_join.sql` (applied)

| Object | Purpose |
|---|---|
| `landlord_pool_legacy_members` | one row per joined older portfolio (join time, category, status and principal at join). **Rows can never be changed or deleted** (trigger) |
| `treasury_controls` `landlord_pool_legacy_from` | the switch. Off until the join run turns it on with the join time |
| `treasury_controls` `landlord_pool_legacy_ceiling` | optional ceiling (UGX) on older-portfolio pool money. Off |
| `landlord_pool_legacy_skips` | the part of a top-up or compound that the ceiling kept out |
| `landlord_pool_is_member(portfolio)` | `pool_eligible` **or** (switch on and joined). Replaces the `pool_eligible` test in the top-up / compound and release steps |
| `landlord_pool_reserve_increment` | now accepts joined older portfolios, and applies the ceiling to them only |
| `trg_landlord_pool_increment_on_ledger` | uses `landlord_pool_is_member` |
| `landlord_pool_legacy_release` + `trg_landlord_pool_release_on_change` | J3 rule for joined older portfolios. New portfolios are unchanged |
| `v_landlord_pool_legacy_missed` | control: a top-up or compound on a joined portfolio with no pool record. **Must be empty** |
| `v_portfolio_pool_category` | adds `legacy_joined_at` |
| `landlord_pool_join_legacy_portfolios()` + `landlord_pool_legacy_join_runs` | the one-shot join run, with the same safeguards as the category run |
| pg_cron `landlord-pool-legacy-join-once` (id 42388) | `0-55/5 17 7 10 *`: 20:00 EAT on 7 Oct, retries to 20:55. Refuses after 21:00, and **refuses to start unless tonight's category run succeeded** |

**Not changed:**
- house claims: `allocate_company_managed_portfolio` stays new-portfolios-only (`20261006150100`);
- principal reserve for new portfolios, rent funding, tenant repayments, cancellations, the 24-hour recall.

### Rehearsal (production, one transaction, rolled back)

All the steps were simulated together: tagging, joining 1,353 portfolios, then the money events below.

| Step | Result |
|---|---|
| Compounding 100,000 + top-up 200,000 on an older company-managed portfolio | entries `compound` 100,000 and `topup` 200,000. A22 +300,000, A1 −300,000 |
| Rent funded 50,000 from that portfolio's compound money | drawn 50,000 |
| Partial redemption 120,000 | 120,000 released from the newest money (the top-up). Compound 50,000 in pool, 50,000 out with the tenant |
| Ceiling with 30,000 of room; top-up 100,000 on the older self-support portfolio | 30,000 reserved (A21), 70,000 recorded as skipped |
| Full redemption | everything still in the pool released. The 50,000 out with the tenant comes back on repayment |
| Compounding on an older portfolio that did not join (cancelled) | ignored |
| House claims / pool exceptions / missed events | 0 / 0 / 0 |
| Pool ledger groups | 7, all balanced; no wallet-scope pool legs |
| Books vs pool records (A21, A22) | 0 difference |
| Join-run dry run | 1,353 members = target; switch on; no ledger rows; rolled back |

### Timeline

| When (EAT) | What |
|---|---|
| 6 Oct 20:00 | category run tags 1,359 older portfolios (no money) |
| 7 Oct 20:00 | join run: 1,353 active and locked older portfolios join; switch on |
| 8 Oct 09:00 onwards | first compounding payments go into the pool (Returns processing) |
| 8 Oct 19:00 onwards | first merged top-ups go into the pool |
| 8 Oct morning, then weekly | checks: books = pool records, `v_landlord_pool_legacy_missed` empty, 0 exceptions, money path 17/17, pool size vs spare cash |

### Watch: spare cash is lower than when this was assessed

At 13:39 EAT on 6 Oct:
- spare cash (A1) was **256.9m**, down from 488.6m on 5 Oct;
- the pool was 124.2m.

At September's rate (about 38m a day in, about 7m a day out to rent), spare cash would show **zero about a week after joining**, not two. The ceiling (J4) is the lever if the CFO wants to slow this:

```sql
UPDATE treasury_controls SET enabled = true, value = '<UGX ceiling>' WHERE control_key = 'landlord_pool_legacy_ceiling';
```

### Undo

Turn the switch off:

```sql
UPDATE treasury_controls SET enabled = false WHERE control_key = 'landlord_pool_legacy_from';
```

New top-ups and compounding then stop going in, and principal drops stop releasing. To return the money already in, release each joined portfolio's pool money with `landlord_pool_legacy_release`. Membership rows stay as the record.
