# Where the money goes when a portfolio is created

Checked against the edge functions on `lovable` and the **live production** RPCs and `ledger_account_map` on 2026-09-29.

---

## Short answer

**Creating a portfolio does not send money to a "platform treasury" wallet. No such wallet exists.** The "Rent Management Pool" that appears in ledger descriptions is a label (`linked_party`). It is not an account or a wallet.

The partner's cash reached company cash (**A1, Cash and Bank Balances**, which is treasury) when they **deposited** it into their wallet. At that point the company recorded it as money it owes the partner: **L1, Wallet Custody Payable**.

Creating the portfolio changes only which liability holds that money:

```
Dr L1  Wallet Custody Payable            (the partner's wallet balance goes down)
Cr L2  Partner Portfolios — Capital Held (the partner's portfolio capital goes up)
```

- **Treasury cash (A1 + A5) does not change.** `get_treasury_cash_position()` shows the same figure before and after.
- The partner's **wallet** goes down, because that is the only leg that touches a wallet balance.
- The company still owes the partner the same amount. The debt has moved from "wallet balance" to "portfolio capital", and the partner can no longer withdraw it.

The two cases differ in what happens to the **cash** after that:

| | Portfolio that does **not** support a tenant | Portfolio that **does** support a tenant (for comparison) |
|---|---|---|
| Liability | L1 → L2 | L1 → L2 |
| Cash | **Stays in A1 (treasury)** as unallocated pool money | **Leaves A1 straight away** and becomes a Rent Plan receivable (A3) |
| Tenant / landlord effect | none | the tenant's agent gets landlord float; the rent request is marked `funded` |

---

## Case 1: portfolio created without supporting a tenant

Two sources create this kind of portfolio.

### 1a. Rent-pool portfolio (partner self-serve)

`FundRentDialog` → `fund-rent-pool` → `funder_create_pending_portfolio` → Partner Ops approves → `approve-pending-portfolio` / `approve_pending_portfolio`

1. **At creation, no money moves.** `funder_create_pending_portfolio` inserts `investor_portfolios` with `status = 'pending_ops_approval'` and a `funder_pending_portfolios` row with `source = 'rent_pool'`. The amount counts as a **hold** against the partner's operational float (`funder_pending_hold`), but there is no ledger entry. The partner is told: "Your money stays in your wallet until it is approved."
2. **On approval**, one balanced group is posted (idempotency key `portfolio-funding-<id>` or `funder-pending-<id>`):

   | Leg | Scope | Bucket | Category | Direction | Account | Effect |
   |---|---|---|---|---|---|---|
   | Partner | wallet | **float** | `partner_funding` | cash_out | **L1** (Dr) | partner's operational float goes down |
   | Company | platform | — | `partner_funding` | cash_in | **L2** (Cr) | portfolio capital liability goes up |

3. **Nothing else happens.** No landlord float is released, no rent request is funded, and nothing is posted to A1 or A3. The cash stays in treasury as undeployed pool capital until a later rent disbursement from the pool uses it.

### 1b. Self-support house (verified empty house, no tenant)

`approve_pending_portfolio` with `source = 'self_managed_house'`, idempotency key `psh-commit-<commitment_id>`:

| Leg | Scope | Bucket | Category | Account |
|---|---|---|---|---|
| Partner | wallet | float | `supporter_rent_fund` | **L1** (Dr) |
| Company | platform | — | `partner_funding` | **L2** (Cr) |

The RPC says: *"No tenant exists, so NOTHING is released to landlord or agent float."* The accounting matches 1a: **cash stays in A1**.

### For comparison: a portfolio that does support a tenant (`source = 'self_managed'`)

This path starts with the same L1 → L2 group (`supporter_rent_fund` wallet leg, key `psm-commit-*`). It then calls `psm_disburse_landlord_float`, which posts a second group for each funded rent request:

| Leg | Scope | Category | Account | Effect |
|---|---|---|---|---|
| Company | platform | `rent_disbursement` cash_out | **A1** (Cr) | **cash leaves treasury** |
| Company | bridge | `rent_receivable_created` cash_in | **A3** (Dr) | Rent Plan receivable from the tenant |

It also creates an `agent_landlord_float_allocations` row for the tenant's agent and sets the rent request to `funded`. **This is the key difference: only tenant-bound portfolios take cash out of treasury when they are created.**

---

## Case 2: portfolio created directly (by staff or an agent)

Several entry points exist. All of them debit a wallet **immediately**, with no Partner Ops approval step, and none of them links the money to a tenant.

| Entry point | Called from | Wallet debited | Company leg | Account |
|---|---|---|---|---|
| `coo-create-portfolio` | COO tools | the chosen source wallet (partner, or proxy agent) | `partner_funding` | **L2** |
| `coo-invest-for-partner` | `COOPartnersPage`, `ActivePartnersDetail` | the partner's wallet | `partner_funding` | **L2** |
| `create-portfolio-invite` (+ `approve_pending_portfolio`) | COO / Executive / Manager dialogs | the partner's **float** | `partner_funding` | **L2** |
| `agent-invest-for-partner` | `AgentInvestForPartnerDialog` | the **agent's** wallet | `partner_funding` | **L2** (net) |
| `create-investor-portfolio`, instant mode | `CreateUserInviteDialog` | partner, managed-proxy agent, or a chosen user; withdrawable or float | **`pending_portfolio_topup`** | **L6** |
| `coo-wallet-to-portfolio` | `COOPartnersPage` | the partner's wallet | **`pending_portfolio_topup`** | **L6** |
| `create-investor-portfolio`, queued mode | agent-created / no partner | **nothing** yet; only a `pending_wallet_operations` row (`supporter_facilitation_capital`) | — | none until approved |

The journal for the L2 rows is the same one shown above:

```
Dr L1  Wallet Custody Payable            (the funding wallet goes down)
Cr L2  Partner Portfolios — Capital Held
```

**Treasury cash does not change here either.** The money was already in A1 from the original deposit.

### Two variations to know about

- **L6 instead of L2.** `create-investor-portfolio` (instant) and `coo-wallet-to-portfolio` post the company leg as `pending_portfolio_topup`, which maps to **L6, Partner Top-Ups Awaiting Application**, not L2. The description reads "Capital received … applied at activation". Until that happens, the money sits in L6. The total owed is the same, but reports that read L2 will not include it.
- **`agent-invest-for-partner` posts three groups:** agent wallet → L2, then L2 → partner wallet, then partner wallet → L2. The net result is correct (agent L1 down, L2 up). However, the return values of groups 2 and 3 are never checked (`await adminClient.rpc(...)` with no error handling). If group 2 posts and group 3 fails, the partner is left with a spendable wallet credit instead of portfolio capital. It is worth hardening.

---

## Account mappings used (live `ledger_account_map`)

| Scope | Bucket | Category | Account | `debit_when` |
|---|---|---|---|---|
| wallet | float | `partner_funding` | L1 | cash_out |
| wallet | * | `partner_funding` | L1 | cash_out |
| wallet | * | `supporter_rent_fund` | L1 | cash_out |
| platform | * | `partner_funding` | L2 | cash_out |
| bridge | * | `partner_funding` | L2 | cash_out |
| platform | * | `pending_portfolio_topup` | L6 | cash_out |
| bridge | * | `supporter_facilitation_capital` | L2 | cash_out |
| platform | * | `rent_disbursement` | A1 | cash_in |
| bridge | * | `rent_receivable_created` | A3 | cash_in |

Note: the **float-bucket** `partner_funding` wallet row pointed to **A2 (Cash at Hand — Float with Agents)** until **2026-09-24**. That mapping made rent-pool approvals look like cash leaving agents' hands. It was corrected to L1. Balance-sheet readings from before that date for these groups used the old account.

---

## Summary

1. **Portfolio that does not support a tenant** (rent pool or self-support house): the partner's wallet/float goes down, and the company records portfolio capital owed (**L2**). **The cash stays in treasury (A1)** as undeployed pool money. For self-serve rent-pool portfolios, nothing is posted until Partner Ops approves.
2. **Portfolio created directly by staff or an agent**: the chosen wallet goes down immediately, and the company records **L2**, or **L6** for the two `pending_portfolio_topup` paths. **The cash stays in treasury (A1).** It was already there from the deposit.
3. **Treasury cash only goes down when money is deployed to a tenant**: `rent_disbursement` (Cr A1) paired with a Rent Plan receivable (Dr A3). Among portfolio-creation paths, only the tenant-bound `self_managed` path does this at creation.

Production volume through the approval queue (`funder_pending_portfolios`) at the time of writing:

| Source | Approved | Rejected |
|---|---|---|
| rent_pool | 7 (UGX 5.45m) | 2 (UGX 0.2m) |
| self_managed (supports a tenant) | 7 (UGX 1.25m) | 1 (UGX 0.1m) |
| self_managed_house | 3 (UGX 0.42m) | — |

Direct staff-created portfolios do not go through this table.
