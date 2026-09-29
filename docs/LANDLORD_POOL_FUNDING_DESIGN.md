# Landlord Float Pool: where portfolio money goes and how we track it

**Status:** built and live in production, **switched off** until cutover · **Date:** 2026-09-29 (revision 4)
**Builds on:** [PORTFOLIO_CREATION_MONEY_FLOW.md](./PORTFOLIO_CREATION_MONEY_FLOW.md)
**Checked against:** live production `ledger_account_map`, `ledger_account_catalog`, `approve_pending_portfolio` and `psm_disburse_landlord_float`, 2026-09-29

---

## 1. The rules (confirmed)

1. **All portfolio money goes into the Landlord Float Pool.** Every new portfolio's principal is posted into the pool when the portfolio is approved.
2. **The pool money is tracked with ledger categories, not labels.** There are two origins:

   | Category origin | When | Examples |
   |---|---|---|
   | **company_managed** | the portfolio has **no** tenant (Rent Plan) and **no** house plan attached | created by you or Partner Ops with nothing attached; a partner's self-serve rent-pool portfolio |
   | **self_support** | the portfolio has **one or more tenants or house plans** attached | a partner supporting specific tenants; a partner supporting a verified house |

3. **House support has no category of its own.** It is a `self_support` posting whose `source_table` is `partner_supported_houses`. Tenant support is `self_support` with `source_table` `partner_self_funding_lines`. Both origins are therefore readable from the ledger alone, with no extra category.
4. **New portfolios only, no backfill.** Existing portfolios are not touched. That stays true until a backfill has been designed and shown to be exact (§8).

### Why categories and not labels

The ledger category is what reports, balances and controls read. A label on the portfolio row, such as a `management_type` column, can be edited, left blank or get out of date, and the money would not show it.

This design still keeps one field on the portfolio: `pool_origin`. The code reads it to **choose which category to post**. It is an input to the posting, not the record of it. Once a posting exists, the category on that posting is the truth.

---

## 2. The whole flow at a glance

```
                     PORTFOLIO APPROVED
                            │
          partner wallet ── L1 → L2 ──  (existing: company now owes the partner portfolio capital)
                            │
                ┌───────────▼────────────┐
                │ RESERVE into the pool  │  Cr A1 free treasury cash
                │ category carries origin│  Dr A21 (self_support) or A22 (company_managed)
                └───────────┬────────────┘
                            │
     ┌──────────────────────┼─────────────────────────────┐
     │ company_managed      │ self_support + house         │ self_support + tenant(s)
     │ waits in A22 until   │ waits in A21 until the       │ DEPLOYED IMMEDIATELY on approval:
     │ ops deploy it to a   │ house gets a tenant, then    │ the tenant's agent is credited
     │ tenant               │ DEPLOYED                     │ landlord float (Cr A21, Dr A3)
     └──────────┬───────────┴──────────────┬──────────────┴───────────┬──────
                │                          │                          │
                ▼                          ▼                          ▼
       ┌───────────────────────────────────────────────────────────────────┐
       │ Tenant repays the agent → the principal part RETURNS to the pool  │
       │ under the same origin (Dr A21/A22). Fees go to revenue, not here. │
       └───────────────────────────────────────────────────────────────────┘
                            │
                            ▼
            Portfolio matures or is redeemed → undeployed money is
            RELEASED from the pool back to treasury, and the partner is
            paid by the existing redemption flow
```

---

## 3. Accounts

`A20` is already used in production, so the next free codes are taken.

| Code | Label | Nature |
|---|---|---|
| **A21** | Landlord Float Pool — Self-Support | current asset (restricted cash) |
| **A22** | Landlord Float Pool — Company-Managed | current asset (restricted cash) |

Pool money is still Welile's cash. It is ring-fenced for landlords instead of being free to spend. Moving money between A1 and A21/A22 is a reclassification between assets: total assets and what the company owes partners (L2) do not change.

Two accounts, one per origin, make the split appear on the balance sheet directly. The categories make the same split appear in the raw ledger.

---

## 4. Categories

Each origin has the same four movements. Every leg is `platform` or `bridge` scope, so **none of them touches anyone's wallet balance**. The partner's wallet was already debited by the existing `partner_funding` / `supporter_rent_fund` leg.

| Movement | company_managed category | self_support category | Account | Other side of the group |
|---|---|---|---|---|
| **Reserve**: money into the pool | `landlord_pool_reserve_company_managed` | `landlord_pool_reserve_self_support` | Dr A22 / A21 | `landlord_pool_reserve_source`: **Cr A1** |
| **Deploy**: agent credited landlord float | `landlord_pool_deploy_company_managed` | `landlord_pool_deploy_self_support` | Cr A22 / A21 | existing `rent_receivable_created`: **Dr A3** |
| **Return**: principal repaid by the tenant | `landlord_pool_return_company_managed` | `landlord_pool_return_self_support` | Dr A22 / A21 | `landlord_pool_return_source`: **Cr A5** (see §5.4) |
| **Release**: undeployed money back to treasury | `landlord_pool_release_company_managed` | `landlord_pool_release_self_support` | Cr A22 / A21 | `landlord_pool_release_target`: **Dr A1** |

In total there are **8 origin categories and 3 counterpart categories**. All pool categories use `debit_when = cash_in`. Reserve and return legs post `cash_in`; deploy and release legs post `cash_out`.

**Rule for every pool leg:** it copies `source_table` and `source_id` from the thing it funds:

| What the posting funds | `source_table` |
|---|---|
| a tenant line | `partner_self_funding_lines` |
| a house | `partner_supported_houses` |
| a company-managed portfolio | `investor_portfolios` |

This is what makes house support readable without its own category.

---

## 5. Each flow in detail

### 5.1 Company-managed: nothing attached

**Who creates it:** you, Partner Ops or staff (`coo-create-portfolio`, `coo-invest-for-partner`, `create-portfolio-invite`, `create-investor-portfolio`, `coo-wallet-to-portfolio`), an agent (`agent-invest-for-partner`), or the partner through self-serve rent pool (`fund-rent-pool`).

**When it enters the pool:** when the portfolio is **approved**, meaning the moment it becomes `active`.
- The staff paths activate instantly, so for them creation and approval happen in the same moment.
- For the two paths that park money in L6 first (`create-investor-portfolio` instant mode and `coo-wallet-to-portfolio`), the reserve happens when L6 is applied at activation. An L6 top-up can still be cancelled and refunded before then.

```
Group 1 (existing, unchanged)
  wallet   partner_funding                          cash_out   Dr L1
  platform partner_funding                          cash_in    Cr L2

Group 2 (new)                                       key: lp-reserve-<portfolio_id>
  platform landlord_pool_reserve_company_managed    cash_in    Dr A22
  platform landlord_pool_reserve_source             cash_out   Cr A1
```

The money **waits in A22** until ops deploy it to a tenant (§5.3).

### 5.2 Self-support: tenant(s) or house plan(s) attached

**Who creates it:** the partner, through the self-managed flow. **When:** on approval, inside `approve_pending_portfolio`.

#### a) Tenant attached: the money enters the pool and leaves straight away

This matches your understanding: when the portfolio is approved, the agent is credited landlord float, and that credit is the moment the money leaves the pool.

All of this happens in one transaction, **one group per tenant line**:

```
Group 1 (existing, unchanged)                       key: psm-commit-<commitment_id>
  wallet   supporter_rent_fund     (float)          cash_out   Dr L1
  platform partner_funding                          cash_in    Cr L2

Group 2 (new): reserve                              key: lp-reserve-<line_id>
  platform landlord_pool_reserve_self_support       cash_in    Dr A21
  platform landlord_pool_reserve_source             cash_out   Cr A1

Group 3 (CHANGED): deploy to the agent's landlord float
                                                    key: psm-float-<line_id>  (unchanged)
  platform landlord_pool_deploy_self_support        cash_out   Cr A21     ← was rent_disbursement, Cr A1
  bridge   rent_receivable_created                  cash_in    Dr A3
```

Group 3 is the only change to existing behaviour. `psm_disburse_landlord_float` currently posts `rent_disbursement`, which takes the money straight out of treasury (Cr A1). It will post `landlord_pool_deploy_self_support`, which takes it out of the pool (Cr A21), instead.

Everything else stays the same: the `agent_landlord_float_allocations` row, the `agent_float_funding` row, and the rent request being marked `funded`. The allocation row gains two columns, `pool_origin` and `pool_entry_id`.

**Net effect on approval:** A1 down, A3 up, A21 back to zero for that line. The pool is still in the chain, so the ledger shows the money went *through* the self-support pool to this tenant.

#### b) House plan attached, no tenant yet

```
Group 1 (existing)                                  key: psh-commit-<commitment_id>
  wallet   supporter_rent_fund     (float)          cash_out   Dr L1
  platform partner_funding                          cash_in    Cr L2

Group 2 (new)                                       key: lp-reserve-<house_row_id>
  platform landlord_pool_reserve_self_support       cash_in    Dr A21    source_table = partner_supported_houses
  platform landlord_pool_reserve_source             cash_out   Cr A1
```

The money **waits in A21**. When a tenant moves into the house, it is deployed exactly like §5.2a group 3. The deploy leg keeps `source_table = partner_supported_houses`, so the trail from house to tenant is not lost.

**To see house support at any time:** filter on category `landlord_pool_%_self_support` **and** `source_table = 'partner_supported_houses'`. No extra category is needed.

### 5.3 Deploying company-managed money

The new RPC `landlord_pool_deploy(p_rent_request_id, p_amount, p_origin, p_entry_ids DEFAULT NULL)` works the same way as group 3 in §5.2a, but draws from A22. By default it takes the oldest money first; ops can name specific pool entries instead.

```
  platform landlord_pool_deploy_company_managed     cash_out   Cr A22
  bridge   rent_receivable_created                  cash_in    Dr A3
```

### 5.4 Return: the tenant repays the agent and the money comes back

**This part does not exist today.** Currently the tenant pays the agent and the collection reduces A3. The cash sits with the agent (A5) and ends up in general treasury. **Nothing tells it to go back to a pool.** It has to be built.

**What comes back:** only the **principal** part of each instalment.

A tenant repays principal + access fee + registration fee. The repayment waterfall `post_rent_fee_collection` already splits each instalment into these parts for plans funded on or after 2026-09-08. Every new portfolio qualifies, so the split is always available.
- **Fees** are Welile's revenue (R1). They never go back to the pool.
- **Principal** goes back to the pool under the origin it was deployed from.

**When it posts:** straight after `post_rent_fee_collection` succeeds for a collection. The origin comes from the tenant's rent request → `agent_landlord_float_allocations.pool_entry_id` → that pool entry's origin.

```
                                                    key: lp-return-<collection_id>
  platform landlord_pool_return_<origin>            cash_in    Dr A21 / A22
  platform landlord_pool_return_source              cash_out   Cr A5
```

**Why the other side is A5 and not A1:** when the principal is collected, it is with the agent (Cash in Transit, A5), not in the bank yet. Returning it from A5 means the pool counts it as soon as the tenant pays. The trade-off is that, for a short time, part of the pool is cash the agent has not banked yet. The subledger (§6) records this per movement, so it can be reported separately if needed.

> **Must verify before building.** A5 is where the resolver injects its synthetic tenant-collection leg (`float_backed_collection_counterpart`, Dr A5 + Dr L4). The return group has to be tested **raw and resolved** against live `sofp_ledger_legs`, to prove A5 nets correctly and no shape override captures it.

**What the returned money can do next:**

| Origin | Returned money goes to |
|---|---|
| company_managed | back into A22, available to fund the next tenant |
| self_support | back into A21, under the same partner's pool entry; whether the partner re-picks the next tenant is decision **D4** in §9 |

**If the tenant does not repay:** nothing comes back. The shortfall stays in A3 as an overdue Rent Plan. The partner is still owed their capital (L2), exactly as today. The pool is never topped up to hide a default.

### 5.5 Release: the portfolio matures or is redeemed

Money still in the pool for that portfolio (never deployed, or returned and not redeployed) goes back to treasury. Then the existing `process-portfolio-redemption` pays the partner out of A1.

```
                                                    key: lp-release-<pool_entry_id>-<ref>
  platform landlord_pool_release_<origin>           cash_out   Cr A21 / A22
  platform landlord_pool_release_target             cash_in    Dr A1
```

A release can never be larger than that entry's remaining balance. Money still out with tenants comes back only through returns (§5.4).

### 5.6 Reversals

Each group is reversed by an equal and opposite group using the same categories. The reversal's idempotency key is the original key prefixed with `rev-`.

---

## 6. Subledger: every shilling traced to its portfolio

```sql
CREATE TABLE public.landlord_pool_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id     uuid NOT NULL REFERENCES investor_portfolios(id),
  partner_id       uuid NOT NULL,
  origin           text NOT NULL CHECK (origin IN ('self_support','company_managed')),
  source_table     text NOT NULL,   -- investor_portfolios | partner_self_funding_lines | partner_supported_houses
  source_id        uuid NOT NULL,
  principal        numeric NOT NULL CHECK (principal > 0),
  deployed         numeric NOT NULL DEFAULT 0,
  returned         numeric NOT NULL DEFAULT 0,
  released         numeric NOT NULL DEFAULT 0,
  in_pool          numeric GENERATED ALWAYS AS (principal - deployed + returned - released) STORED,
  out_with_tenants numeric GENERATED ALWAYS AS (deployed - returned) STORED,
  reserve_group_id uuid NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (principal - deployed + returned - released >= 0),
  CHECK (returned <= deployed)
);

CREATE TABLE public.landlord_pool_movements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_entry_id   uuid NOT NULL REFERENCES landlord_pool_entries(id),
  kind            text NOT NULL CHECK (kind IN ('reserve','deploy','return','release','reversal')),
  amount          numeric NOT NULL,
  rent_request_id uuid,
  allocation_id   uuid,             -- agent_landlord_float_allocations.id
  collection_id   uuid,             -- set on return
  ledger_group_id uuid NOT NULL,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

- **Writes** happen only inside the pool RPCs. RLS allows ops roles to SELECT and nothing else. Add both tables to `guard-frontend-ledger-writes.mjs`.
- **Tie-out control:** `SUM(in_pool)` by origin must equal the resolved A21 and A22 balances to the shilling. Any difference is a defect.
- **Reporting view** `v_landlord_pool_position`: in pool and out with tenants, by origin, by partner, and house vs tenant (via `source_table`).

This answers three questions for any portfolio: *how much is waiting, how much is out with tenants, how much has come back?*

---

## 7. Effect on treasury cash

`get_treasury_cash_position()` returns A1 + A5. Pool money moves out of A1 (and, on return, out of A5), so **reported treasury cash will be lower by whatever sits in the pool**, even though no money has left the bank.

- **Company-managed** money lowers it for as long as the money is waiting to be deployed.
- **Tenant-attached self-support** money passes straight through, so treasury cash moves exactly as it does today (A1 down, A3 up).
- With no backfill, nothing changes on cutover day. The difference grows gradually from new portfolios only.

**Recommendation:** have `get_treasury_cash_position()` return **free cash** (A1 + A5), **landlord float pool** (A21 + A22) and **total**. Keep existing callers on free cash. Brief finance before cutover.

---

## 8. New portfolios only: no backfill (as built)

- **`investor_portfolios.pool_eligible boolean`** is stamped **once, at insert**, by `trg_aa_landlord_pool_eligibility`: true only if the pool switch was on when the row was inserted, and the row is not a split child. It can never be changed afterwards; an `UPDATE` that tries is ignored. Every row that existed before cutover is false for ever.
- **Why a stamp and not `created_at`.** Measured 2026-09-29: 4 active portfolios worth UGX 5,955,348 carry `created_at` dates in Oct–Dec 2026, in the future. `created_at` is also editable as the "contribution date". A `created_at >= cutover` test would have pulled those old portfolios into the pool, which is exactly the accidental backfill that was ruled out.
- **The cutover switch** is `treasury_controls` row `landlord_pool_from`: `enabled = false` and `value = NULL` today. `landlord_pool_cutover()` returns the timestamp only when it is enabled. While it is off, every pool function and trigger is a no-op.
- A portfolio **inserted** before cutover but approved after it is not eligible; creation decides.
- Tenant funding for pre-cutover portfolios, and for self-managed **top-up** lines, has no pool entry, so it keeps today's behaviour: `rent_disbursement` straight out of A1.
- **`investor_portfolios.pool_origin`** records which origin was posted. It is written by the reserve, never guessed.
- **`v_landlord_pool_unreserved`** lists eligible, active portfolios with no pool entry. It is a detection view, not a block: it has to be empty.

---

## 9. Implementation checklist (as built, 2026-09-29)

All of this is **live in production and inert**: the pool switch is off, 0 portfolios are eligible, and 0 pool legs have been posted.

| Step | Migration / file | Status | Evidence |
|---|---|---|---|
| 1–3 Accounts, mappings, allowlist | `20260929230000_landlord_pool_accounts_and_categories.sql` | ✅ live | A21/A22 in the catalogue; 12 mapping rows (incl. `landlord_pool_deploy_target`); allowlist 162 → 174 |
| 4 Enforcement | — | ✅ verified | Dry runs: every group passed all 40 `general_ledger` triggers, classified `production`, no wallet effect |
| 5 Resolver | — | ✅ verified | `sofp_ledger_legs` has no override or synthetic leg keyed on any pool category or on platform-only groups |
| 6 Base-mapping balance | — | ✅ verified | Every dry-run group DR = CR; 0 `ledger_mapped_balance_violations` |
| 7 Schema | `20260929230100_landlord_pool_schema.sql`, `20260929230300_landlord_pool_eligibility_stamp.sql` | ✅ live | subledger tables + RLS; switch row (off); `pool_origin`, `pool_eligible`; allocation links; detection view |
| 8a Reserve, deploy | `20260929230200_landlord_pool_reserve_and_deploy.sql` | ✅ live | `landlord_pool_reserve`, `landlord_pool_deploy`, `_landlord_pool_post`, activation trigger |
| 8b Returns | `20260929230500_landlord_pool_returns.sql` | ✅ live | `landlord_pool_return`, `landlord_pool_return_reverse`, trigger on `instalment_allocations` |
| 8c Release | `20260929230600_landlord_pool_release.sql` | ✅ live | `landlord_pool_rebalance`, trigger on principal drop / close, rebalance after every return |
| 9 SQL callers | `20260929230400_landlord_pool_sql_callers.sql` | ✅ live | `approve_pending_portfolio` reserves after its debit; `psm_disburse_landlord_float` draws the line's entry. Line diff against live: only the marked additions |
| 9 Edge caller | `supabase/functions/fund-agent-landlord-float/index.ts` | ⏳ **in repo, not deployed** | company-managed draw after the unchanged `rent_disbursement`; non-fatal |
| 10 Treasury RPC | `20260929230700_treasury_cash_position_reports_landlord_pool.sql` | ✅ live | every existing key unchanged (compared as CFO); 4 new keys |
| 11 Verify | — | ✅ | money path 17/17; guards pass; 0 pool exceptions |

### What changed from the design during the build

| Design said | Built as | Why |
|---|---|---|
| Deploy pairs pool CR with `rent_receivable_created` DR A3, **replacing** `rent_disbursement` | `rent_disbursement` + `rent_receivable_created` left untouched; a **separate** pool group `landlord_pool_deploy_<origin>` CR A21/A22 + `landlord_pool_deploy_target` DR A1 sits beside it | 18 DB functions and 23 app files read `rent_disbursement` (reports, cash flow, KPIs, cancel/release reversals). Net effect is identical: pool down, A3 up |
| Each of 8 edge functions calls reserve | One **activation trigger** on `investor_portfolios` (`status` becomes `active`), plus an explicit call in `approve_pending_portfolio` | Portfolios also activate through the COO "Approve" / "Activate all" buttons (a direct status update) and `import-partners`. `enforce_portfolio_funding_at_creation` already guarantees the ledger debit exists at insert, so the trigger catches every path |
| Reserve failure blocks activation | Trigger path is **non-blocking**: a failure is filed in `landlord_pool_exceptions` | The partner's money has already moved by then; unwinding it is worse than a replayable exception |
| Reserve checks `created_at >= cutover` | **Insert-time stamp** `pool_eligible` | future-dated and edited `created_at` (§8) |
| Return from a waterfall wrapper | Trigger on `instalment_allocations` (INSERT → return `principal_component`; `reversed_at` set → reverse) | That table is where the four-part split is already written, once per collection |
| Release at maturity | **Rebalance**: pool ≤ remaining principal − out with tenants; runs on principal drop, redeemed / cancelled / rejected, and after each return | `apply_portfolio_redemption` posts no ledger entries; it only lowers `investment_amount`. `matured` does not release, because matured portfolios can be renewed |

### Rules the code applies

- **Origin** comes from what is attached: `funder_pending_portfolios.source` `self_managed` → one self-support entry per tenant line; `self_managed_house` → one per house; anything else → one company-managed entry.
- **Funding check:** reserve posts only if a wallet `partner_funding` / `supporter_rent_fund` debit for the portfolio exists. Otherwise it returns `not_funded` and moves nothing.
- **Deploy:** one origin per draw (D6). Company-managed draws oldest money first; a self-support tenant line draws its own entry. Any shortfall stays funded by plain treasury.
- **Return:** principal only (fees are revenue), counted on collection out of A5 (D5), paid back to the entries that funded that tenant in draw order. The pool is repaid before treasury's share.
- **Idempotency:** every group uses key `lp-<kind>-<entry>-<ref>`, and the movements table's (entry, group) key stops a retry counting twice.

### Dry runs (production, every one rolled back)

| Scenario | Result |
|---|---|
| Company-managed via staff insert, deploy 2,000, retry both | reserve 3,000 into A22 → 1,000 left; retries `already_*`; no duplicate auto-debit |
| Pre-cutover portfolio re-activated; future-dated portfolio re-activated; `pool_eligible = true` forced | all untouched, 0 entries |
| Partner Ops approves a rent-pool portfolio and a tenant-backed self-managed one | A22 +5,000; A21 +8,000 → 0 (deployed); allocation tagged `self_support`; re-approval no-op; A3 8,000 + A22 5,000 + L1 12,740 + X1 260 = A1 13,000 + L2 13,000 |
| Returns 1,200 then 2,500 (capped at 1,800), then the first reversed | pool 1,200 → 3,000 → 1,800. The first run **caught a double-count bug** (reversal took 2,400); fixed and re-verified |
| Partial redemption, full redemption, then tenant repays on the closed portfolio | releases 500 + 500, then return 1,500 released immediately; pool 0, A22 net 0 |

### Remaining before switch-on

1. **Deploy `fund-agent-landlord-float`.** Until then company-managed money is reserved but not drawn by CFO funding, so the pool only grows; the books still balance.
2. **Brief finance.** Free cash (`total_cash`) drops by `landlord_pool_total` from the first reserve.
3. **Switch on:** `UPDATE treasury_controls SET enabled = true, value = now()::text WHERE control_key = 'landlord_pool_from';`
4. **Daily checks:**
   - `v_landlord_pool_unreserved` empty
   - `landlord_pool_exceptions` with `resolved_at IS NULL` empty
   - `SUM(in_pool)` by origin = A21 / A22

### Known gaps (not blocking)

- **Top-ups and compounding on pre-cutover portfolios** stay in treasury, by decision (§11). On eligible portfolios they are reserved.
- **Split children** (`lock_portfolio_principal`): the parent's lowered principal triggers a release of that share to treasury. The books stay balanced; the pool stops tracking that share.
- **D4 re-use:** returned self-support money waits in A21. There is no flow yet for the partner to point it at a new tenant; it is released at redemption.
- **Plans outside the four-part waterfall** write no `instalment_allocations` row and so never return. Every pool-funded plan is new and inside the waterfall.
- **Pre-existing, seen in passing:**
  - `agent-invest-for-partner` never checks the result of two of its three ledger calls.
  - `create-investor-portfolio` (instant mode) inserts the active portfolio *before* posting its debit, so `enforce_portfolio_funding_at_creation` may auto-debit the partner's float as well. Worth checking for double debits.

**UI (Gemini's lane, for handoff):** pool tiles split by origin and house vs tenant from the new treasury keys; an origin badge on landlord float allocations; an exceptions list.

---

## 10. Decisions

| # | Question | Status |
|---|---|---|
| D1 | What counts as company-managed? | ✅ **Decided:** no tenant and no house plan attached, whoever creates it |
| D2 | Where does tenant-attached money go? | ✅ **Decided:** through the pool as self-support, deployed to the agent's landlord float on approval |
| D3 | Backfill existing portfolios? | ✅ **Decided:** no. New portfolios only, until a backfill is proven exact |
| D4 | Can returned self-support principal fund another tenant? | ✅ **Decided:** yes, the partner chooses. **Not built yet**; the money waits in A21 |
| D5 | When does returned principal count? | ✅ **Decided:** on collection, out of A5 |
| D6 | Can one deploy draw from both origins? | ✅ **Decided:** no, one origin per draw |
| D7 | Treasury figure? | ✅ **Decided:** free cash + pool + total; brief finance first |

---

## 11. Top-ups and compounding (built 2026-09-29)

**Scope (confirmed):** only portfolios that are `pool_eligible`, i.e. created after cutover. Top-ups and compounding on older portfolios stay in treasury exactly as today, so the no-backfill rule stays absolute.

**Each event is its own pool entry under its own category**, so the amounts are never blended into principal:

| Category | Account | Entry `entry_kind` |
|---|---|---|
| `landlord_pool_topup_company_managed` | A22 | `topup` |
| `landlord_pool_topup_self_support` | A21 | `topup` |
| `landlord_pool_compound_company_managed` | A22 | `compound` |
| `landlord_pool_compound_self_support` | A21 | `compound` |

Each is paired with `landlord_pool_reserve_source` (CR A1). Once reserved, top-up and compound entries are deployed, repaid and released by the same machinery as principal entries.

**Hooks** (migrations `20260929230800`, `20260929230900`):

| Event | Ledger shape today | Hook |
|---|---|---|
| Top-up **applied** | `pending_portfolio_topup` cash_out (L6) + `partner_funding` cash_in (L2) | deferred constraint trigger `trg_zz_landlord_pool_increment` on `general_ledger`. It reads the whole group at the end of the transaction |
| Top-up **cancelled** | `pending_portfolio_topup` cash_out + **wallet** `partner_funding` cash_in | ignored (no L2 leg) |
| **Compounding** | `roi_expense` cash_out + `roi_reinvestment` cash_in (L2) | same trigger, on the `roi_reinvestment` leg |
| **Self-managed top-up** adding tenants | `supporter_rent_fund` (key `psm-topup-<id>`), then `psm_disburse_landlord_float(…, p_topup_id, …)` | each new line is reserved as a self-support top-up, then deployed straight to the agent |

**Compounding is not new cash.** It is Returns kept instead of paid out, so reserving it earmarks the treasury cash that would otherwise have left.

The **rebalance** now uses the larger of the portfolio's principal and its self-managed commitment. This matters because self-managed top-ups raise the commitment, not the portfolio row.

**Reading the numbers:** `v_landlord_pool_position` gives, per portfolio, origin, attachment (portfolio / tenant / house) and `entry_kind` (principal / topup / compound): reserved, deployed, returned, released, in pool and out with tenants.

**Dry runs (rolled back):**

| Scenario | Result |
|---|---|
| Eligible portfolio 3,000; compounding 450; top-up applied 1,000; top-up cancelled 200; compounding 777 on a pre-cutover portfolio | principal 3,000, compound 450, topup 1,000; cancel and old portfolio ignored; A22 +4,450 / A1 −4,450; 0 violations |
| Self-managed portfolio (tenant 8,000) plus a self-managed top-up adding a tenant (6,000) | principal 8,000 and topup 6,000, both self-support tenant entries, both fully deployed; allocation tagged `self_support`; 0 exceptions |
