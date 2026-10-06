# Older portfolios into the Landlord Float Pool by category: implementation plan

**Decision:** Option B from [LEGACY_PORTFOLIOS_POOL_IMPACT.md](./LEGACY_PORTFOLIOS_POOL_IMPACT.md). The older portfolios join the pool **by category only**. No money moves.
**When:** one scheduled run, **6 October 2026 at 20:00 EAT** (17:00 UTC), when Partner Operations is inactive.
**Dry run:** done with the real function on 6 Oct 2026 at 13:20 EAT, rolled back. Clean (see §6).
**Status:** **installed.** pg_cron job `landlord-pool-legacy-category-once` (id 42387) is scheduled.

> **Found during installation: house claims.** On 5 Oct, separate work added "company-managed portfolios claim empty houses" (`20261005140000_…`). Its trigger fires whenever a portfolio's category becomes company-managed. Its own spec says older portfolios are "excluded permanently", but it assumed only new portfolios would ever carry that category.
>
> Without a fix, tagging would have made ~1,354 older portfolios (9.69bn) claim almost all **6,403 empty houses** (5.8bn of rent) and emptied the funder queue.
>
> **Fixed** by `20261006150100_company_managed_allocation_requires_pool_eligible.sql` (applied): only pool-eligible portfolios can claim houses. The run also checks that **no house claim** is written.

---

## 1. What "moving" means here

Every portfolio has a **category** field (`pool_origin`). New portfolios get it automatically when their money enters the pool. The older portfolios have it empty.

The run fills it in, once, for every older portfolio:

| Category | Rule | Portfolios | Principal today (UGX) |
|---|---|---|---|
| **Company-managed** | nothing attached: no tenant, no house | 1,357 (1,347 active, 5 locked, 4 cancelled, 1 redeemed) | 9,696,600,608 |
| **Self-support** | the portfolio came from supporting a tenant or a house | 2 (1 tenant, 1 house, both active) | 700,000 |
| **Total** | | **1,359** (at the 6 Oct dry run) | |

Principal is read **live** from each portfolio. It was 9.586bn this morning and 9.598bn at the dry run, because compounding and top-ups keep adding to it. Nothing is copied, so the figure is always current.

**No separate "legacy" flag.** Each portfolio already carries a fixed "pool / not pool" stamp (`pool_eligible`) from the day it was created:

- Every older portfolio is stamped "not pool". The stamp **cannot be changed**: the database resets it if anyone tries.
- Every automatic pool step (set money aside, top-up, compounding, release, rebalance) **checks this stamp first** and does nothing for "not pool". This was confirmed in all the live functions.

So after the run, an older portfolio has a category but still never moves money in or out of the pool.

---

## 2. Effect on the books

**None.** The run writes no ledger entry.

| Figure | Before | After |
|---|---|---|
| Free cash (A1) | unchanged | unchanged |
| Landlord Float Pool, company-managed (A22) | unchanged | unchanged |
| Landlord Float Pool, self-support (A21) | unchanged | unchanged |
| Partner capital owed (L2) | unchanged | unchanged |
| Wallets (L1) | unchanged | unchanged |
| Pool records vs books | match | match |

**What changes in reporting:** the pool reports can now show **all** partner capital by category. Each line says how much actually sits in the pool as cash.

| Category | Partner capital behind it | Cash in the pool |
|---|---|---|
| Company-managed: new portfolios | live principal | yes, as recorded in the pool |
| Company-managed: older portfolios | live principal | **no**, category only |
| Self-support: new | live principal | yes |
| Self-support: older | live principal | **no**, category only |

---

## 3. Effect on portfolios and partners

| Item | Effect |
|---|---|
| Portfolio amount, Returns rate, duration, maturity, payout day | none |
| Returns payouts (monthly and scheduled) | none |
| Compounding | none. It keeps adding to principal exactly as now, and no money is set aside |
| Top-ups (including the 18:00 auto-apply) | none. Applied as now, no money set aside |
| Redemptions, renewals, splitting / locking | none. Older portfolios still release nothing from the pool, because they never put anything in |
| Partner wallets | none |
| What partners see on their dashboard | none. The category is internal |
| Portfolio change log / partner notices | **none written.** The change log only tracks amount, dates, rate, duration and status. The run keeps its own record instead (§4) |

---

## 4. How the run works

### Objects installed beforehand (one migration)

| Object | Purpose |
|---|---|
| `landlord_pool_legacy_category_runs` | one row per run: start and finish time, status, before and after snapshots, rows updated, error if any |
| `landlord_pool_legacy_category_log` | one row per portfolio categorised: portfolio, category given, status and principal at that moment. This is the audit trail and the undo list |
| `landlord_pool_categorise_legacy_portfolios()` | the run itself. SECURITY DEFINER, callable only by the system (`service_role` / cron), not by users |
| `v_portfolio_pool_category` | report: every portfolio, old and new, with category, live principal, "cash in pool: yes / no" and the amount in the pool |
| pg_cron job `landlord-pool-legacy-category-once` | fires the run tonight (see the schedule below) |

### What the function does, in one transaction (all or nothing)

1. **Already done?** If a successful run exists, it stops and removes the cron job. It can never run twice.
2. Sets a short lock wait (10 seconds), so it never queues behind other work. If the table is busy, it gives up cleanly and the next attempt tries again.
3. **Before snapshot:**
   - number of ledger rows;
   - balances of A1, A21 and A22;
   - pool records vs books;
   - pool movement and exception counts;
   - count and principal by status.
4. Selects the older portfolios with an empty category: "not pool" stamp, category empty.
5. Gives each one its category (rule in §1) and writes one line per portfolio to the log.
6. Fills in the category field. No other field is touched.
7. **After snapshot** of the same figures.
8. **Checks** (any failure rolls everything back and records the error):
   - ledger row count unchanged;
   - A1, A21 and A22 unchanged;
   - pool movements and exceptions unchanged;
   - no portfolio's "pool / not pool" stamp changed;
   - rows updated = rows logged;
   - no older portfolio left without a category;
   - pool records still match the books.
9. Records the run as **succeeded** and **removes its own cron job**.

### Schedule

| | |
|---|---|
| Cron expression | `0-55/5 17 6 10 *` (pg_cron runs in UTC). The function refuses to run after 21:00 EAT on 6 Oct and removes the job, so the expression's yearly repeat can never fire it |
| Means | 20:00 EAT on 6 Oct. If that attempt could not get the table, it retries every 5 minutes until 20:55. After the first success, the job deletes itself |
| Other jobs nearby | top-ups applied 18:00; paid-out top-ups merged 19:00; agent report 20:00 (read-only); renewals 00:00; payouts 03:00; Returns processing 09:00. **Nothing that changes portfolios runs at 20:00** |

If every attempt up to 20:55 fails, nothing has changed. The failed attempts are recorded in the runs table, and we look at why the next morning.

---

## 5. After the run: checks and report

The next morning I run these and report:

1. The runs table shows **succeeded**, with about 1,359 rows (plus any older portfolio unlocked since).
2. Before and after snapshots are identical except for the categories.
3. Pool controls ([LANDLORD_FLOAT_POOL_TECHNICAL.md](./LANDLORD_FLOAT_POOL_TECHNICAL.md) §10):
   - books = pool records;
   - 0 missed;
   - 0 open exceptions;
   - money path 17/17.
4. `v_portfolio_pool_category` totals agree with the portfolio table.
5. The cron job is gone.

**Undo, if ever needed:** set the category back to empty for the portfolios listed in the log for that run. This touches no money, so it is equally safe.

---

## 6. Dry-run result (6 Oct 2026, 13:20 EAT, real function, rolled back)

| Check | Result |
|---|---|
| Portfolios categorised | 1,359 |
| Active company-managed | 1,347 / UGX 9,692,176,766 |
| Active self-support | 2 / UGX 700,000 |
| Locked / cancelled / redeemed (company-managed) | 5 / 4 / 1 |
| New ledger rows | 0 |
| New pool movements | 0 |
| New pool exceptions | 0 |
| New change-log entries / partner notices | 0 |
| **New house claims** | **0** (the guard works) |
| "Pool / not pool" stamps changed | 0 |
| Books vs pool records | 0 difference before and after |
| Run time | seconds. The first attempt, before the guard, took over 60s because each row ran the house allocator |

---

## 7. What this does not do

- It does **not** set any cash aside for older portfolios (Option C). That stays a separate CFO decision.
- It does **not** send older top-ups or compounding into the pool (Option D).
- It does not change any screen. Showing the categories on dashboards is a UI task for Gemini, using `v_portfolio_pool_category`.

---

## 8. Steps and sign-off

| # | Step | When |
|---|---|---|
| 1 | Plan approved | now |
| 2 | Install the migration (tables, function, view) and the cron job. Run the function once more as a dry run inside a rollback | today, before 20:00 |
| 3 | Commit the migration file and this plan to `lovable` | today |
| 4 | Job fires | 20:00 EAT |
| 5 | Post-run checks (§5) and short report | next morning |
| 6 | Update the pool guide and technical reference | after step 5 |
