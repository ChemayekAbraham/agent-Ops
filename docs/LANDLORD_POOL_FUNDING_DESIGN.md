# Landlord Pool: routing tenant-less portfolio money

**Status:** proposal, not yet built · **Date:** 2026-09-29
**Builds on:** [PORTFOLIO_CREATION_MONEY_FLOW.md](./PORTFOLIO_CREATION_MONEY_FLOW.md)
**Checked against:** live production `ledger_account_map` and `ledger_account_catalog`, 2026-09-29

---

## 1. What changes

**Today.** A portfolio that does not support a tenant moves the partner's money from their wallet into portfolio capital (Dr L1 → Cr L2). The cash stays in treasury (A1) with nothing marking it as partner money. There is no way to tell which part of A1 came from which portfolio, and no way to tell self-support money from company-managed money.

**After the upgrade.** When a tenant-less portfolio becomes active, its principal is **reserved into the Landlord Pool**. Every shilling in the pool carries a permanent origin tag:

| Origin | Meaning |
|---|---|
| **Self-support** | A **house is attached** to the portfolio, and no tenant (a verified empty house the partner is supporting). |
| **Company-managed** | **No tenant and no house is attached.** Who created the portfolio (the partner, staff or an agent) does not matter. |

The pool then pays landlords. Each payout records which origin it came from, so at any moment we can answer three questions:

1. How much is in the Landlord Pool, split into self-support and company-managed?
2. Which portfolio did this landlord payout come from, and what was its origin?
3. How much of a given portfolio is still undeployed?

**Out of scope:** tenant-bound portfolios (`source = 'self_managed'`). They already pay the tenant's landlord straight away through `psm_disburse_landlord_float` and never reach the pool. That flow is unchanged.

---

## 2. Classifying every portfolio

### The rule (confirmed 2026-09-29)

The origin depends only on **what is attached to the portfolio**, not on who created it or which screen was used:

| Attached to the portfolio | `management_type` | Goes to pool? |
|---|---|---|
| a tenant (a rent request via `partner_self_funding_lines`) | `tenant_bound` | ❌ unchanged, pays the landlord directly |
| a house but no tenant (`partner_supported_houses`) | **`self_support`** | ✅ → A21 |
| **nothing** (no tenant, no house) | **`company_managed`** | ✅ → A22 |

An opportunity `summary_id`, which `fund-rent-pool` and `agent-invest-for-partner` can pass, **does not count as attached**. It points to a pooled summary of rent demand, not to a particular tenant or house.

Origin is decided **once, when the portfolio is created**, and never inferred afterwards. It is stored on the portfolio itself, because the direct staff paths never write `funder_pending_portfolios`.

**New column:** `investor_portfolios.management_type text`, with a CHECK constraint allowing `self_support`, `company_managed` and `tenant_bound`.

### What each entry point produces

| Entry point | Tenant or house attached? | `management_type` | Goes to pool? |
|---|---|---|---|
| `approve_pending_portfolio`, `source = 'self_managed_house'` | house | **self_support** | ✅ |
| `approve_pending_portfolio`, `source = 'rent_pool'` (partner self-serve via `fund-rent-pool`) | none | **company_managed** | ✅ |
| `coo-create-portfolio` | none | **company_managed** | ✅ |
| `coo-invest-for-partner` | none | **company_managed** | ✅ |
| `create-portfolio-invite` (+ approve) | none | **company_managed** | ✅ |
| `agent-invest-for-partner` | none | **company_managed** | ✅ |
| `create-investor-portfolio` (instant and queued) | none | **company_managed** | ✅ once applied from L6 |
| `coo-wallet-to-portfolio` | none | **company_managed** | ✅ once applied from L6 |
| `approve_pending_portfolio`, `source = 'self_managed'` | tenant | **tenant_bound** | ❌ unchanged |

If any of these entry points later gains the ability to attach a house or tenant, it follows the rule above rather than this table.

### No backfill: new portfolios only (confirmed 2026-09-29)

This change applies **only to portfolios created after the cutover**. Existing portfolios are not reclassified and are not reserved into the pool. That stays true until a backfill has been designed separately and shown to be exact.

- **Existing rows** keep `management_type = NULL`, meaning "created before the Landlord Pool". NULL is never guessed or filled in.
- **New rows** must have a value. An insert trigger `trg_portfolio_require_management_type` raises an error if `management_type` is NULL on any portfolio created after the cutover timestamp (stored in `treasury_controls` as `landlord_pool_cutover_at`). This stops a path that was missed from quietly creating unclassified portfolios.
- **Reserve refuses NULL.** `landlord_pool_reserve()` raises an error for any portfolio whose `management_type` is NULL or `tenant_bound`. A pre-cutover portfolio therefore cannot be pushed into the pool by accident, including on a retry or re-approval.
- **Pending portfolios at cutover.** A portfolio created before the cutover but approved after it counts as pre-cutover: it stays NULL and does not enter the pool. Only the *creation* time matters, so every portfolio follows one rule from start to finish.
- **Existing money stays where it is.** Existing L2 capital stays in A1, exactly as it is today. The pool balance starts at zero on the cutover day and grows only from new portfolios.

---

## 3. New accounts

`A20` is already used in production (Agent Advance Registration Fees Receivable), so the next free codes are used.

| Code | Label | Nature | Section |
|---|---|---|---|
| **A21** | Landlord Pool — Self-Support Funds | asset | current_asset |
| **A22** | Landlord Pool — Company-Managed Funds | asset | current_asset |

**Why two accounts rather than one with a tag.** The user requirement is that we *must* know the origin. A category tag alone shows the split only in reports that group by category. Two accounts make the split appear on the **balance sheet itself**, in `get_statement_of_financial_position`, with no extra query. It costs one more catalogue row.

**Both are asset accounts, and specifically restricted cash.** The pool money is still in Welile's bank. It is ring-fenced for landlords rather than free to spend. Moving money from A1 into A21 or A22 is a reclassification **between assets**: total assets and L2 do not change.

---

## 4. New ledger categories

All legs are **`platform` or `bridge` scope**, so none of them moves a wallet balance. The partner's wallet was already debited by the existing `partner_funding` / `supporter_rent_fund` leg. The new legs only say where the company holds and spends that cash.

| Category | Scope | Account | `debit_when` | Used for |
|---|---|---|---|---|
| `landlord_pool_reserve_self_support` | platform | **A21** | cash_in | money into the pool, self-support |
| `landlord_pool_reserve_company_managed` | platform | **A22** | cash_in | money into the pool, company-managed |
| `landlord_pool_reserve_source` | platform | **A1** | cash_in | the other side of a reserve: cash leaves free treasury |
| `landlord_pool_deploy_self_support` | platform | **A21** | cash_in | pool pays a landlord, self-support |
| `landlord_pool_deploy_company_managed` | platform | **A22** | cash_in | pool pays a landlord, company-managed |
| `landlord_pool_release_self_support` | platform | **A21** | cash_in | undeployed money leaves the pool (redemption or maturity) |
| `landlord_pool_release_company_managed` | platform | **A22** | cash_in | undeployed money leaves the pool (redemption or maturity) |
| `landlord_pool_release_target` | platform | **A1** | cash_in | the other side of a release: cash returns to free treasury |

The deploy legs pair with the **existing** `rent_receivable_created` (bridge → A3, cash_in). No new receivable category is needed.

**Why the origin is in the category name and not only in the account.** The account alone already tells us the origin, so this looks redundant. It is deliberate:

- Edge functions and reports filter `general_ledger` by `category`, not by resolved account (see `balancedLedgerPost.ts`).
- If someone later changes a mapping row, origin-named categories still show the truth in the raw ledger.

---

## 5. The flows

### 5.1 Reserve: the portfolio becomes active and money goes into the pool

**When it happens.** In the same transaction that makes the portfolio `active`:

- `approve_pending_portfolio`, for `rent_pool` and `self_managed_house`
- the direct staff functions, right after their `partner_funding` group posts
- for the L6 paths, when `pending_portfolio_topup` is applied to L2 at activation (not at creation, because an L6 top-up can still be cancelled and refunded)

**Group 1: the existing partner debit, unchanged**

```
wallet   partner_funding / supporter_rent_fund   cash_out   Dr L1   partner wallet goes down
platform partner_funding                         cash_in    Cr L2   company owes the partner portfolio capital
```

**Group 2: new, the pool reserve.** Its own `transaction_group_id` and idempotency key `lp-reserve-<portfolio_id>`.

Self-support:
```
platform landlord_pool_reserve_self_support      cash_in    Dr A21  pool (self-support) goes up
platform landlord_pool_reserve_source            cash_out   Cr A1   free treasury cash goes down
```

Company-managed:
```
platform landlord_pool_reserve_company_managed   cash_in    Dr A22  pool (company-managed) goes up
platform landlord_pool_reserve_source            cash_out   Cr A1   free treasury cash goes down
```

Why group 2 is posted separately instead of adding its legs to group 1:
- Group 1 is already emitted by eight different code paths, and several run through `balancedLedgerPost.ts`. Leaving it untouched means no existing caller breaks.
- A 2-leg platform-only group has `n_wallet = 0`, so none of the resolver's shape overrides can capture it (§8, step 5).

**Net effect of groups 1 and 2 together:**

| Account | Change |
|---|---|
| L1 Wallet Custody Payable | − principal |
| L2 Partner Portfolio Capital | + principal |
| A1 Cash and Bank | − principal |
| A21 / A22 Landlord Pool | + principal |

Assets and liabilities each change only between their own lines, so the balance sheet still balances.

### 5.2 Deploy: the pool pays a landlord for a tenant's Rent Plan

**When it happens.** An ops user, or an automated matcher, assigns pool money to a rent request.

**New RPC:** `landlord_pool_deploy(p_rent_request_id uuid, p_amount numeric, p_origin text, p_entry_ids uuid[] DEFAULT NULL)`. It is SECURITY DEFINER and gated by an ops role, following the same pattern as `psm_disburse_landlord_float`.

1. Choose which pool entries to draw from (§6). By default it takes the oldest money of the requested origin first; ops can instead name specific entries.
2. Post one group per pool entry used, with idempotency key `lp-deploy-<pool_entry_id>-<rent_request_id>`:

```
platform landlord_pool_deploy_<origin>   cash_out   Cr A21/A22   pool goes down
bridge   rent_receivable_created         cash_in    Dr A3        Rent Plan receivable from the tenant
```

3. Insert `agent_landlord_float_allocations` with two new columns, `pool_origin` and `pool_entry_id`. The `source` column is set to `'landlord_pool'`.
4. Insert `agent_float_funding` and set `rent_requests.status = 'funded'`, exactly as `psm_disburse_landlord_float` does today.

From this point, the landlord payout, the agent float cycle and tenant repayments all run on the **existing** rails. The only difference is that the allocation row remembers which pool, and which portfolio, funded it.

### 5.3 Release: money leaves the pool without going to a landlord

This covers redemption, maturity or cancellation while part of the principal is still undeployed. Idempotency key `lp-release-<pool_entry_id>-<reason_ref>`:

```
platform landlord_pool_release_<origin>   cash_out   Cr A21/A22   pool goes down
platform landlord_pool_release_target     cash_in    Dr A1        free treasury cash goes up
```

After this, the existing redemption flow (`process-portfolio-redemption`) pays the partner out of A1 exactly as it does today.

**Rule:** a release can never be larger than the entry's undeployed balance. Money that has been deployed comes back through tenant repayments, not through a release.

### 5.4 Reversals

Every group above is reversed by an equal and opposite group using the **same** categories, following the existing `*_reversal` convention. Reversal keys are the original key prefixed with `rev-`.

---

## 6. Subledger: tracing every shilling back to a portfolio

The accounts give totals. The subledger gives the per-portfolio trail.

```sql
CREATE TABLE public.landlord_pool_entries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id       uuid NOT NULL REFERENCES investor_portfolios(id),
  partner_id         uuid NOT NULL,
  origin             text NOT NULL CHECK (origin IN ('self_support','company_managed')),
  principal          numeric NOT NULL CHECK (principal > 0),
  deployed           numeric NOT NULL DEFAULT 0,
  released           numeric NOT NULL DEFAULT 0,
  remaining          numeric GENERATED ALWAYS AS (principal - deployed - released) STORED,
  reserve_group_id   uuid NOT NULL,            -- general_ledger.transaction_group_id
  status             text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','fully_deployed','closed')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (deployed + released <= principal)
);

CREATE TABLE public.landlord_pool_movements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_entry_id   uuid NOT NULL REFERENCES landlord_pool_entries(id),
  kind            text NOT NULL CHECK (kind IN ('reserve','deploy','release','reversal')),
  amount          numeric NOT NULL,
  rent_request_id uuid,                        -- set on deploy
  allocation_id   uuid,                        -- agent_landlord_float_allocations.id
  ledger_group_id uuid NOT NULL,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

- **Writes** happen only inside the three RPCs: reserve, deploy and release. RLS allows ops roles to SELECT and denies every direct write. The frontend never writes to these tables, and `guard-frontend-ledger-writes.mjs` should add both tables to its denylist.
- **Tie-out control**, to be added to `controls-and-verification`: `SUM(remaining) WHERE origin = 'self_support'` must equal the resolved A21 balance, and the same for company-managed and A22. Any difference is a defect.
- **Reporting view** `v_landlord_pool_position`: remaining balance by origin and by partner, plus the age of the oldest undeployed shilling. This extends the idea behind `landlord_float_idle_alerts` to the pool.

---

## 7. Effect on treasury cash

This is the one visible side effect.

`get_treasury_cash_position()` returns **A1 + A5**. Reserving money moves it from A1 into A21 or A22, so **reported treasury cash will fall by the total held in the pool**, even though no money has left the bank.

**Recommendation:** extend `get_treasury_cash_position()` so it returns three figures:

| Figure | Accounts |
|---|---|
| **free cash** | A1 + A5 (today's figure, now excluding pool money) |
| **landlord pool** | A21 + A22 |
| **total treasury** | free cash + landlord pool |

Callers that expect the old single figure (the daily reports and the CFO tiles) should keep receiving **free cash** under the existing key. This is the more honest number, because pool money is not free to spend on operations. Because there is no backfill, free cash does **not** drop on cutover day. It falls gradually, by exactly the principal of each new tenant-less portfolio as it activates, and rises again as pool money is paid to landlords or released. Tell finance before cutover so the gradual divergence from bank statements is expected.

---

## 8. Implementation checklist

These steps follow the chart-of-accounts "adding a new money flow" rules.

1. **Catalogue:** insert A21 and A22 into `ledger_account_catalog`. Choose `sort_order` values so they sit next to A1 (for example 11 and 12).
2. **Mapping:** add 8 bucket-agnostic rows to `ledger_account_map`, one per category in §4.
3. **Allowlist:** replace `ledger_category_allowlist()` with all existing entries copied **verbatim** plus the 8 new ones. The function is replaced, not appended to. If a category is mapped but not allowlisted, the insert fails. If it is allowlisted but not mapped, the leg posts but silently disappears into A9.
4. **Enforcement:** confirm none of the new categories counts as a "treasury category" that makes the enforcement trigger raise instead of log. The reserve and release legs touch A1, so test this explicitly.
5. **Resolver:** check that no shape override captures a 2-leg platform-only group (reserve and release) or a platform + bridge group (deploy):
   - **Reserve/release:** the overrides need `n_wallet > 0`, `n_a2 > 0` or specific categories, so none fire.
   - **Deploy:** needs verification against the live `sofp_ledger_legs`. The `rent_disbursement` override is keyed on its category and source table `agent_advance_requests`, so it should not fire.
   - Test every group **raw and resolved**.
6. **`balancedLedgerPost.ts`:** the new groups must balance on base mapping alone, with no synthetic legs. All three do (A21/A22 ↔ A1, and A21/A22 ↔ A3).
7. **Schema:** add `management_type` (nullable, **no backfill**) to `investor_portfolios`, set `landlord_pool_cutover_at` in `treasury_controls`, add the insert trigger that requires `management_type` after cutover, create the two subledger tables, and add `pool_origin` / `pool_entry_id` to `agent_landlord_float_allocations`.
8. **RPCs:** `landlord_pool_reserve(portfolio_id)`, `landlord_pool_deploy(...)` and `landlord_pool_release(...)`, all SECURITY DEFINER, all using `create_ledger_transaction` with the idempotency keys in §5.
9. **Callers:**
   - `approve_pending_portfolio` calls reserve for `rent_pool` and `self_managed_house`.
   - The eight direct edge functions call reserve after their existing group posts. If reserve fails, the portfolio must not activate. Use the same rollback pattern each function already has.
   - Fix `agent-invest-for-partner`'s unchecked groups at the same time.
10. **Treasury RPC:** the three-figure `get_treasury_cash_position()` from §7.
11. **Verify:**
    - `assert_money_path_intact()` still 17/17
    - no new `ledger_mapped_balance_violations`
    - the subledger ties to A21/A22 to the shilling
    - `npm run guard:all` passes
12. **Copy:** partner-facing messages say *"Your Rent Plan support is held in the Landlord Pool"*. Never write "loan", "lender", "ROI" or "interest".

**UI (Gemini's lane, flagged for handoff):** pool balance tiles split by origin, the deploy picker, and an origin badge on landlord payouts.

---

## 9. Decisions needed before building

| # | Question | Recommendation |
|---|---|---|
| D1 | Is a self-serve **rent-pool** portfolio self-support or company-managed? | ✅ **Decided:** company-managed. The rule is "no tenant and no house attached" (§2). |
| D2 | Two accounts (A21/A22), or one account plus the category tag? | **Two accounts**, so the balance sheet shows the split directly. |
| D3 | Reserve existing active tenant-less portfolios into the pool, or only new ones? | ✅ **Decided:** new portfolios only. No backfill until a separately designed backfill is shown to be exact (§2). |
| D4 | When the pool pays a landlord, is the money drawn oldest-first automatically, or does ops choose the portfolio? | **Oldest-first by default, with ops override.** The subledger records whichever is chosen. |
| D5 | Can company-managed pool money fund a tenant introduced by a self-support partner, or the other way round? | **No mixing by default.** A deploy draws from one origin only. |
| D6 | Should `get_treasury_cash_position()` switch its main figure to free cash? | **Yes**, and brief finance first (§7). |
