# Landlord Float Pool: where portfolio money goes and how we track it

**Status:** proposal, not yet built · **Date:** 2026-09-29 (revision 3)
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

## 8. New portfolios only: no backfill

- `investor_portfolios.pool_origin text` is **nullable**. Existing portfolios stay NULL, which means "created before the pool", and NULL is never guessed.
- The cutover time is stored in `treasury_controls.landlord_pool_cutover_at`.
- An insert trigger raises an error if a portfolio created after cutover has no `pool_origin`, so a path that was missed fails loudly.
- Every pool RPC refuses a portfolio whose `pool_origin` is NULL. A portfolio **created** before cutover but approved after it stays outside the pool; creation time decides.
- Tenant-attached portfolios created before cutover keep today's behaviour: `rent_disbursement` straight out of A1. `psm_disburse_landlord_float` picks the old or the new path from the portfolio's `pool_origin`.
- Repayments on plans funded before cutover never trigger a return, because they have no `pool_entry_id`.

---

## 9. Implementation checklist

1. **Catalogue:** add A21 and A22 to `ledger_account_catalog`.
2. **Mapping:** add 11 bucket-agnostic rows to `ledger_account_map`, one per category in §4.
3. **Allowlist:** replace `ledger_category_allowlist()` with all existing entries copied **verbatim** plus the 11 new ones. If a category is mapped but not allowlisted, the insert fails. If it is allowlisted but not mapped, the leg posts but silently disappears into A9.
4. **Enforcement:** confirm how the trigger treats the new categories. The legs touch A1 and A5, so test this explicitly.
5. **Resolver:** test every group raw and resolved against live `sofp_ledger_legs`. Pay particular attention to the **return** group (A5 synthetic) and the changed **deploy** group (the replacement for `rent_disbursement`).
6. **`balancedLedgerPost.ts`:** every new group must balance on base mapping alone. They do: A2x ↔ A1, A2x ↔ A3, A2x ↔ A5.
7. **Schema:** `pool_origin` column, cutover setting and insert trigger; the two subledger tables; `pool_origin` / `pool_entry_id` on `agent_landlord_float_allocations`.
8. **RPCs** (SECURITY DEFINER, `create_ledger_transaction`, keys as in §5): `landlord_pool_reserve`, `landlord_pool_deploy`, `landlord_pool_return`, `landlord_pool_release`.
9. **Callers:**
   - `approve_pending_portfolio` reserves for all sources.
   - `psm_disburse_landlord_float` switches to pool deploy for post-cutover portfolios.
   - The direct staff edge functions reserve after their existing group. If reserve fails, the portfolio must not activate.
   - `post_rent_fee_collection` (or a wrapper) triggers the return.
   - Fix `agent-invest-for-partner`'s unchecked ledger calls at the same time.
10. **Treasury RPC:** three figures (§7).
11. **Verify:**
    - `assert_money_path_intact()` still 17/17
    - no new `ledger_mapped_balance_violations`
    - the subledger ties to A21/A22
    - `npm run guard:all` passes
12. **Copy:** "Rent Plan", "Supporter/Partner" and "Returns" only. Never write "loan", "lender", "ROI" or "interest".

**UI (Gemini's lane, for handoff):** pool tiles split by origin, and house vs tenant; the deploy picker; an origin badge on landlord float allocations.

---

## 10. Decisions

| # | Question | Status |
|---|---|---|
| D1 | What counts as company-managed? | ✅ **Decided:** no tenant and no house plan attached, whoever creates it |
| D2 | Where does tenant-attached money go? | ✅ **Decided:** through the pool as self-support, deployed to the agent's landlord float on approval |
| D3 | Backfill existing portfolios? | ✅ **Decided:** no. New portfolios only, until a backfill is proven exact |
| D4 | When a self-support tenant repays, can that returned principal fund another tenant? If so, does the partner choose, or ops? | ❓ **Open.** Suggest the partner chooses, because it is self-support |
| D5 | Is returned principal counted in the pool when the agent collects it (from A5), or only once it is banked? | ❓ **Open.** Suggest on collection (§5.4), with a subledger column for unbanked amounts |
| D6 | Can one deploy draw from both origins? | ❓ **Open.** Suggest no. Each deploy draws from one origin |
| D7 | Should `get_treasury_cash_position()` report free cash as its main figure? | ❓ **Open.** Suggest yes, and brief finance first |
