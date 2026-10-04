# Landlord Float Pool: technical reference

**Status:** live in production since `2026-09-30 09:29:51 UTC` (`treasury_controls.landlord_pool_from`).
**Plain-language guide:** [LANDLORD_FLOAT_POOL_GUIDE.md](./LANDLORD_FLOAT_POOL_GUIDE.md)
**Design history and dry-run evidence:** [LANDLORD_POOL_FUNDING_DESIGN.md](./LANDLORD_POOL_FUNDING_DESIGN.md)
**Posting model:** `.claude/skills/welile-chart-of-accounts/` (read it before changing anything here)

---

## 1. Model in one paragraph

Every pool movement is a **balanced platform-scope ledger group** in `general_ledger`. It moves value between free treasury cash (**A1**, or **A5** for collections) and one of two restricted-cash asset accounts: **A21** (self-support) or **A22** (company-managed). No pool leg is `wallet` scope, so **no pool posting ever moves a wallet balance**. Beside the ledger, a **subledger** (`landlord_pool_entries` + `landlord_pool_movements`) records which portfolio, tenant line, house or returned-rent stream each shilling belongs to. The control invariant is:

```
Σ landlord_pool_entries.in_pool  (origin = X)  ==  mapped ledger balance of the matching account (A21 / A22)
```

---

## 2. Switch and eligibility

| Object | Purpose |
|---|---|
| `treasury_controls` row `landlord_pool_from` | `enabled` + `value` (the cutover timestamp). Both must be set for the pool to act |
| `landlord_pool_cutover()` | returns the cutover, or `NULL` when off. Every pool function checks it |
| `investor_portfolios.pool_eligible boolean` | stamped **once at INSERT** by `trg_aa_landlord_pool_eligibility`: `cutover IS NOT NULL AND locked_from_portfolio_id IS NULL`. Immutable: any later UPDATE resets it to the old value |
| `investor_portfolios.pool_origin` | `self_support` / `company_managed`, written by the reserve (a record of what was posted, never guessed) |

**Why a stamp, not `created_at`:** on 2026-09-29, 4 active portfolios (UGX 5.96m) had future `created_at` values, and `created_at` is editable as the "contribution date". A `created_at >= cutover` test would have back-filled them.

**Scope rules:**
- no backfill: pre-cutover portfolios, and their top-ups and compounding, never reserve;
- split children (`lock_portfolio_principal`) are never eligible.

---

## 3. Accounts and categories

### Accounts (`ledger_account_catalog`)

| Code | Label | Nature / section |
|---|---|---|
| **A21** | Landlord Float Pool — Self-Support | asset / current_asset (sort 11) |
| **A22** | Landlord Float Pool — Company-Managed | asset / current_asset (sort 12) |

Both are included in `get_statement_of_financial_position`, which builds its lines from the catalogue.

### Categories (`ledger_account_map`, all `platform` scope, bucket-agnostic, `debit_when = cash_in`)

| Category | Account | Posted as | Meaning |
|---|---|---|---|
| `landlord_pool_reserve_company_managed` | A22 | cash_in (DR) | principal reserved |
| `landlord_pool_reserve_self_support` | A21 | cash_in (DR) | principal reserved |
| `landlord_pool_topup_company_managed` | A22 | cash_in (DR) | applied top-up reserved |
| `landlord_pool_topup_self_support` | A21 | cash_in (DR) | applied top-up reserved |
| `landlord_pool_compound_company_managed` | A22 | cash_in (DR) | compounded Returns reserved |
| `landlord_pool_compound_self_support` | A21 | cash_in (DR) | compounded Returns reserved |
| `landlord_pool_reserve_source` | **A1** | cash_out (CR) | counterpart: free cash set aside. Also the counterpart of a cancellation return |
| `landlord_pool_deploy_company_managed` | A22 | cash_out (CR) | pool pays a tenant |
| `landlord_pool_deploy_self_support` | A21 | cash_out (CR) | pool pays a tenant |
| `landlord_pool_deploy_target` | **A1** | cash_in (DR) | counterpart: pool money back to treasury to fund the unchanged `rent_disbursement` |
| `landlord_pool_return_company_managed` | A22 | cash_in (DR); cash_out on reversal | tenant principal returned |
| `landlord_pool_return_self_support` | A21 | cash_in (DR); cash_out on reversal | tenant principal returned |
| `landlord_pool_return_source` | **A5** | cash_out (CR) | counterpart: collected principal leaves Cash in Transit |
| `landlord_pool_release_company_managed` | A22 | cash_out (CR) | undeployed money released |
| `landlord_pool_release_self_support` | A21 | cash_out (CR) | undeployed money released |
| `landlord_pool_release_target` | **A1** | cash_in (DR) | counterpart: released money back to free cash |

All 16 are in `ledger_category_allowlist()`, which now has 178 entries.

**Every pool leg must set `ledger_scope` explicitly.** `auto_assign_ledger_scope()` defaults unknown categories to `wallet`.

---

## 4. Tables

### `landlord_pool_entries`: one row per funded thing

| Column | Notes |
|---|---|
| `id` | PK |
| `portfolio_id` | FK `investor_portfolios`. **NULL only for `entry_kind = 'returned'`** |
| `partner_id` | NULL only for `returned` |
| `origin` | `self_support` / `company_managed` |
| `entry_kind` | `principal` / `topup` / `compound` / `returned` |
| `source_table`, `source_id` | what the entry funds. **UNIQUE together** |
| `principal` | amount reserved (for `returned`, a running total) |
| `deployed`, `returned`, `released` | running totals |
| `in_pool` | generated: `principal − deployed + returned − released` |
| `out_with_tenants` | generated: `deployed − returned` |
| `reserve_group_id` | ledger group of the reserve |
| `status` | `open` / `closed` (a `returned` entry never closes) |

`source_table` values:

| Value | Entry | `source_id` |
|---|---|---|
| `investor_portfolios` | company-managed principal | portfolio id |
| `partner_self_funding_lines` | self-support tenant line (principal or top-up) | line id |
| `partner_supported_houses` | self-support house | house row id |
| `general_ledger` | portfolio top-up or compounding | the triggering ledger leg id |
| `returned_principal` | the running returned-rent entry | `md5('returned_principal:' \|\| origin)::uuid`, one per origin |

**Constraints:**
- `in_pool >= 0`
- `returned <= deployed`
- `principal >= 0`
- portfolio and partner required unless `returned`

### `landlord_pool_movements`: every change, one row per ledger group

- **Kinds:** `reserve`, `deploy`, `return`, `release`, `reversal`, `recovered`, `recovered_reversal`.
- **Columns:** `rent_request_id`, `allocation_id`, `collection_id`, `ledger_group_id`, `created_by`.
- **Key:** `UNIQUE (pool_entry_id, ledger_group_id)` stops an idempotent retry from counting twice.

### `landlord_pool_exceptions`: replay queue

Rows record `operation`, `caller`, `reason` (SQLERRM), a `detail` jsonb, and `resolved_at` / `resolved_by`. Every trigger-driven pool step is **non-blocking**: on failure it writes here and lets the business action proceed.

### Links on existing tables

| Column | Meaning |
|---|---|
| `investor_portfolios.pool_eligible`, `pool_origin` | §2 |
| `agent_landlord_float_allocations.pool_origin`, `pool_entry_id` | the pool entry that funded a landlord float |

**Access:** all pool tables have RLS enabled. SELECT is limited to partner ops, CFO, COO, manager, financial_ops and super_admin, plus partners on their own entries. There are **no write policies**; only SECURITY DEFINER functions write.

### Views

| View | Use |
|---|---|
| `v_landlord_pool_position` | per portfolio × origin × `attached_to` (portfolio / tenant / house / returned_rent) × `entry_kind`: reserved, deployed, returned, released, in_pool, out_with_tenants |
| `v_landlord_pool_unreserved` | `pool_eligible` active portfolios with no entry. **Must be empty** |

---

## 5. Functions

All are `SECURITY DEFINER`. EXECUTE is revoked from `PUBLIC` / `anon` / `authenticated` and granted to `service_role`.

| Function | Role |
|---|---|
| `landlord_pool_cutover()` | switch read |
| `_landlord_pool_post(entry, kind, amount, ref, rr, alloc, collection, description)` | the only poster for `deploy` / `return` / `cancel_return` / `return_reversal` / `release`. Posts the group, writes the movement, updates the totals. Key `lp-<kind>-<entry>-<ref>` |
| `landlord_pool_reserve(portfolio, funding_group_ids, caller)` | principal reserve. Origin from attachments (`funder_pending_portfolios.source`: `self_managed` → one entry per tenant line; `self_managed_house` → one per house; else one company-managed entry). **Posts only if a wallet `partner_funding` / `supporter_rent_fund` debit exists**, otherwise returns `not_funded`. Returns status `pool_off` / `pre_cutover` / `not_active` / `split_child` / `not_funded` / `already_reserved` / `reserved` |
| `landlord_pool_reserve_increment(portfolio, 'topup'\|'compound', amount, source_table, source_id, caller)` | reserve for a top-up or compounding event. Eligible, non-closed portfolios only |
| `landlord_pool_deploy(rr, amount, origin, allocation, entry, caller)` | draws up to `amount` from **one origin**, oldest first (or a named entry). Idempotent per allocation. Refuses while the plan still has pool money out. Returns `drawn` and `shortfall` |
| `landlord_pool_return(rr, principal, ref, collection, caller)` | returns principal to the entries that funded that plan, in draw order, capped at what is outstanding |
| `landlord_pool_return_reverse(ref, caller)` | reverses the returns for one instalment allocation |
| `landlord_pool_cancel_return(rr, amount, caller)` | on cancellation: gives the reversed float back to the funding entries (counterpart A1), then rebalances |
| `landlord_pool_rebalance(portfolio, caller)` | pool may hold ≤ `greatest(investment_amount, self-commitment amount) − out_with_tenants` (0 once `redeemed` / `cancelled` / `rejected`). The excess is released, newest money first |
| `landlord_pool_record_returned_principal(leg)` | records a returned-rent leg posted outside the pool functions into the running `returned` entry |
| `get_treasury_cash_position()` | existing keys unchanged (so `total_cash` is now **free** cash). Adds `landlord_pool_self_support`, `landlord_pool_company_managed`, `landlord_pool_total`, `total_treasury_incl_pool` |

---

## 6. Triggers (the hooks)

| Trigger | On | Fires | Does |
|---|---|---|---|
| `trg_aa_landlord_pool_eligibility` | `investor_portfolios` BEFORE INSERT / UPDATE OF pool_eligible | always | stamps / freezes `pool_eligible` |
| `trg_zz_landlord_pool_reserve` | `investor_portfolios` AFTER INSERT / UPDATE OF status | status becomes `active` | `landlord_pool_reserve`, non-blocking |
| `trg_zz_landlord_pool_release` | `investor_portfolios` AFTER UPDATE OF investment_amount, status | principal drops, or redeemed / cancelled / rejected | `landlord_pool_rebalance`, non-blocking |
| `trg_zz_landlord_pool_return` | `instalment_allocations` AFTER INSERT / UPDATE OF reversed_at | the plan has a pool deploy | return `principal_component` (INSERT) or reverse it (`reversed_at` set), then rebalance |
| `trg_zz_landlord_pool_increment` | `general_ledger` **deferred constraint trigger** | platform `roi_reinvestment` cash_in, or platform `pending_portfolio_topup` cash_out **whose group has a platform `partner_funding` cash_in** | compound / top-up reserve at end of transaction. A cancelled top-up (L6 → wallet) has no such leg and is ignored |
| `trg_zz_landlord_pool_returned_principal` | `general_ledger` AFTER INSERT | platform `landlord_pool_return_*` whose key is not `lp-%` | records returned rent into the `returned` entry |

`zz_` naming makes these fire after `trg_enforce_portfolio_funding_at_creation`, which guarantees the wallet debit exists at insert.

---

## 7. Changed callers (outside the pool functions)

| Where | Change |
|---|---|
| `approve_pending_portfolio` | flips status **before** posting its own debit, so it calls `landlord_pool_reserve` explicitly after the debit and before `psm_disburse_landlord_float`. The audit row carries `landlord_pool` |
| `psm_disburse_landlord_float` | keeps its `rent_disbursement` + `rent_receivable_created` group **unchanged**. Beside it: `landlord_pool_deploy(…, 'self_support', alloc, line_entry)` when the line has an entry. For self-managed **top-ups** (`p_topup_id`, funding key `psm-topup-<id>`) it first reserves each new line as a `topup` entry |
| `cancel_tenant_and_return_landlord_float` | (1) system mode for the recall; (2) reverses only the **booked** net `rent_disbursement` for the plan (rent request and its self-funding lines), linking to the earliest un-reversed funding group; (3) hands the reversed amount to `landlord_pool_cancel_return` |
| `detect_idle_landlord_float` | sets `app.system_context = 'landlord_float_recall'` before cancelling |
| Edge function `fund-agent-landlord-float` | after its unchanged `rent_disbursement` group: `landlord_pool_deploy(rr, rent, 'company_managed', allocation)`, non-blocking, failures to `landlord_pool_exceptions`. Re-funding a previously cancelled plan uses key `…:<allocation>:float` |
| `_post_four_part_fee_split` (Lovable, `drizzle/migrations/0352_…`) | posts principal of **every** collection as `landlord_pool_return_<origin>` + `landlord_pool_return_source` (A5 → pool), except plans the pool funded (then the return trigger does it). Recorded into the `returned` entry by `trg_zz_landlord_pool_returned_principal` |

**Why `rent_disbursement` was never replaced:** 18 database functions and 23 app files read it (reports, cash flow, KPIs, cancel / release reversals). The pool draw sits beside it with the same net effect.

---

## 8. Journals

Amounts are illustrative. DR/CR are resolved through `ledger_account_map`.

**Reserve (principal / top-up / compound)**
```
DR A21|A22   landlord_pool_{reserve|topup|compound}_<origin>
CR A1        landlord_pool_reserve_source
```

**Deploy** (beside the unchanged funding group `CR A1 rent_disbursement / DR A3 rent_receivable_created`)
```
CR A21|A22   landlord_pool_deploy_<origin>
DR A1        landlord_pool_deploy_target
Net: pool −X, A3 +X, A1 unchanged
```

**Return (collection)**
```
DR A21|A22   landlord_pool_return_<origin>
CR A5        landlord_pool_return_source
```

**Cancellation return**
```
DR A21|A22   landlord_pool_return_<origin>
CR A1        landlord_pool_reserve_source
```

**Release**
```
CR A21|A22   landlord_pool_release_<origin>
DR A1        landlord_pool_release_target
```

### Idempotency keys

| Group | Key |
|---|---|
| principal reserve | `lp-reserve-<source_table>-<source_id>` |
| top-up / compound reserve | `lp-<kind>-<source_table>-<source_id>` |
| posted by `_landlord_pool_post` | `lp-<kind>-<entry>-<ref>` |
| deploy | `ref` = allocation id (or rent request id) |
| return | `ref` = `instalment_allocations.id` |
| cancel | `ref` = `cancel-<rr>-<timestamp>` |
| release | `ref` = a random uuid per rebalance (a rebalance is idempotent by construction) |

---

## 9. End-to-end flows

```
Portfolio created ──(status→active)──► trg_zz_landlord_pool_reserve ─► landlord_pool_reserve
   │                                     (approve_pending_portfolio also calls it after its debit)
   ├─ nothing attached ──────────► entry company_managed/principal ─► waits
   ├─ tenant line(s) ────────────► entry self_support/principal per line
   │                                  └─ psm_disburse_landlord_float ─► landlord_pool_deploy (same txn)
   └─ house(s) ──────────────────► entry self_support/principal per house ─► waits

Top-up applied / compounding ───► deferred ledger trigger ─► landlord_pool_reserve_increment ─► topup/compound entry
Self-managed top-up (tenants) ──► psm_disburse(p_topup_id) ─► increment per line ─► deploy

CFO funds tenant ───────────────► fund-agent-landlord-float ─► landlord_pool_deploy('company_managed')
Tenant repays ──────────────────► instalment_allocations
      ├─ pool-funded plan ──────► trg_zz_landlord_pool_return ─► landlord_pool_return ─► rebalance
      └─ other plans ───────────► four-part split posts return legs ─► returned entry
Plan cancelled / recalled ──────► cancel_tenant_and_return_landlord_float ─► landlord_pool_cancel_return
Principal drops / closed ───────► trg_zz_landlord_pool_release ─► landlord_pool_rebalance ─► release
```

---

## 10. Controls: run these to verify

```sql
-- Subledger ties to the books (both rows must match)
SELECT m.account_code,
       SUM(CASE WHEN gl.direction = m.debit_when THEN gl.amount ELSE -gl.amount END) AS ledger
  FROM general_ledger gl
  JOIN ledger_account_map m ON m.ledger_scope = gl.ledger_scope AND m.category = gl.category AND m.wallet_bucket IS NULL
 WHERE m.account_code IN ('A21','A22') GROUP BY 1;
SELECT origin, SUM(in_pool) FROM landlord_pool_entries GROUP BY 1;

-- Nothing missed, nothing failed (both must be 0)
SELECT count(*) FROM v_landlord_pool_unreserved;
SELECT count(*) FROM landlord_pool_exceptions WHERE resolved_at IS NULL;

-- Position report
SELECT * FROM v_landlord_pool_position ORDER BY origin, entry_kind;

-- Money path (must be 17/17)
SELECT count(*) FILTER (WHERE ok), count(*) FROM assert_money_path_intact();
```

**Result on 2026-09-30:**
- 94 pool groups, 0 unbalanced (mapped and raw), 0 A9 legs, 0 logged violations;
- A21 50,000 = subledger; A22 12,491,125 = subledger;
- 0 missed, 0 open exceptions, money path 17/17.

---

## 11. Migrations and commits

| Migration | Content |
|---|---|
| `20260929230000_landlord_pool_accounts_and_categories.sql` | A21 / A22, first 11 mappings, allowlist |
| `20260929230100_landlord_pool_schema.sql` | subledger tables, RLS, switch row, allocation links, detection view |
| `20260929230200_landlord_pool_reserve_and_deploy.sql` | `deploy_target`, reserve / deploy / post functions, activation trigger |
| `20260929230300_landlord_pool_eligibility_stamp.sql` | `pool_eligible` stamp |
| `20260929230400_landlord_pool_sql_callers.sql` | `approve_pending_portfolio`, `psm_disburse_landlord_float` |
| `20260929230500_landlord_pool_returns.sql` | returns + reversal trigger |
| `20260929230600_landlord_pool_release.sql` | rebalance / release |
| `20260929230700_treasury_cash_position_reports_landlord_pool.sql` | treasury keys |
| `20260929230800_landlord_pool_topups_and_compounding.sql` | top-up / compound categories, deferred trigger, position view |
| `20260929230900_landlord_pool_self_managed_topups.sql` | self-managed top-up lines |
| `20260929231000_landlord_float_recall_runs_as_system.sql` | recall system mode; booked-only reversal |
| `20260930160000_landlord_pool_returned_principal_and_cancellations.sql` | returned-rent entry, cancellation return, re-fund deploy |

**Commits on `lovable`:**

| Commit | Content |
|---|---|
| `43a0c5018e` | pool |
| `40ce666af7` | recall fix |
| `f2e561a7a4` | returned rent / cancellations |
| `c5dab50a4a` | house-support screen |

---

## 12. Known gaps and open defects

| Item | Detail |
|---|---|
| House entry → tenant | no hook deploys a `partner_supported_houses` entry when a tenant later takes the house. The money waits until release |
| Returned self-support money re-use (D4) | no partner-facing flow yet |
| Returned rent | one running entry per origin, not attributed per portfolio |
| Split children | lowering the parent's principal releases that share; the child is never eligible |
| 6 re-funded plans (≈UGX 1.35m) | re-funding before the fix posted no ledger funding; 2 had reversals posted anyway. Needs an approved correction |
| `fund-agent-landlord-float` deployment | pushed; confirm the deployed version in Supabase |
| Pre-existing, seen in passing | `agent-invest-for-partner` does not check two ledger calls; `create-investor-portfolio` instant mode inserts before posting its debit (possible double debit via the funding trigger) |
| UI | pool tiles, origin badges and an exceptions list are Gemini's to design. The data is ready |

**Rules for anyone changing this:**
- never post pool categories without `ledger_scope`;
- never replace `rent_disbursement`;
- keep the allowlist verbatim when replacing it;
- re-run §10 after any change.
