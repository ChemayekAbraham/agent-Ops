# What moves when you create a portfolio: by portfolio type

**Date:** 2026-09-29 · **Applies to:** commit `43a0c5018e` on `lovable`
**Detail and test evidence:** [LANDLORD_POOL_FUNDING_DESIGN.md](./LANDLORD_POOL_FUNDING_DESIGN.md)

> **Status: the Landlord Float Pool is built but switched OFF.** Until the switch (`treasury_controls.landlord_pool_from`) is turned on, every portfolio behaves exactly as it did before today: only the "Today" rows in the tables below happen. Once it is on, the rows marked **Pool** are added, but **only for portfolios created after the switch-on**. Portfolios that already exist never enter the pool.

All examples use **UGX 1,000,000**.

---

## The accounts you'll see

| Account | What it is | Kind |
|---|---|---|
| **Partner wallet** | the partner's own balance (withdrawable or operational float) | what the partner sees |
| **L1** Wallet Custody Payable | what Welile owes partners sitting in their wallets | liability |
| **L2** Partner Portfolios — Capital Held | what Welile owes partners inside portfolios | liability |
| **L6** Partner Top-Ups Awaiting Application | top-ups received but not yet added to a portfolio | liability |
| **A1** Cash and Bank (**free cash**) | treasury cash free to spend | asset |
| **A21** Landlord Float Pool — Self-Support | cash ring-fenced for landlords, self-support money | asset |
| **A22** Landlord Float Pool — Company-Managed | cash ring-fenced for landlords, company-managed money | asset |
| **A3** Rent Plan receivables | what tenants owe back | asset |
| **A5** Cash in Transit | cash collected by agents, not yet banked | asset |
| **Agent landlord float** | money given to an agent to pay a specific landlord | operational |

**Rule of thumb:** A21 and A22 are still Welile's cash, but ring-fenced for landlords. Moving money between A1 and A21/A22 changes **free cash**, not **total cash**.

---

## 1. Company-managed portfolio (no tenant, no house plan attached)

**How it's created:**
- by staff: COO, Partner Ops or an agent, which activates at once; or
- by the partner through the rent-pool screen, which activates when Partner Ops approves.

| | Goes UP | Goes DOWN | Unchanged |
|---|---|---|---|
| **Today** | L2 +1,000,000 (Welile owes the partner portfolio capital) | Partner wallet −1,000,000 · L1 −1,000,000 | A1 (the cash was already in treasury from the deposit) |
| **Pool** | **A22 +1,000,000** · category `landlord_pool_reserve_company_managed` | **A1 free cash −1,000,000** · category `landlord_pool_reserve_source` | total cash (A1 + A22) · tenants · agents |

**End state:** the partner is owed 1,000,000 in the portfolio. The money sits in the **company-managed pool** until the CFO funds a tenant (§5).

A few staff paths (`create-investor-portfolio` instant mode, `coo-wallet-to-portfolio`) record the liability in **L6** instead of L2 until activation. The pool reserve is the same.

**Partner self-serve (rent pool):** from submission until approval, only a **hold** on the partner's float is placed. No money moves and nothing enters the pool. Both rows above happen at the moment Partner Ops approves.

---

## 2. Self-support portfolio with tenant(s) attached

**How it's created:** a partner picks one or more tenants' Rent Plans, and Partner Ops approves.

| | Goes UP | Goes DOWN |
|---|---|---|
| **Today** | L2 +1,000,000 · **A3 +1,000,000** (the tenant owes the Rent Plan) · **agent landlord float +1,000,000** | Partner float −1,000,000 · L1 −1,000,000 · **A1 −1,000,000** (cash leaves treasury to fund the tenant) |
| **Pool: in** | A21 +1,000,000 · `landlord_pool_reserve_self_support` | A1 −1,000,000 · `landlord_pool_reserve_source` |
| **Pool: straight out to the agent** | A1 +1,000,000 · `landlord_pool_deploy_target` | A21 −1,000,000 · `landlord_pool_deploy_self_support` |

**Net effect:** the same as today (A1 −1,000,000, A3 +1,000,000, agent float +1,000,000). The ledger now also shows that the money passed **through the self-support pool** to this tenant. The agent's landlord-float allocation is tagged `self_support`, and the rent request is marked `funded`.

Unchanged from before: Welile also recognises the tenant's access and registration fees as receivable (A3 up, L7 up). No cash moves for that.

---

## 3. Self-support portfolio with a house plan attached (no tenant yet)

**How it's created:** a partner supports a verified empty house, and Partner Ops approves.

| | Goes UP | Goes DOWN |
|---|---|---|
| **Today** | L2 +1,000,000 | Partner float −1,000,000 · L1 −1,000,000 |
| **Pool** | A21 +1,000,000 · `landlord_pool_reserve_self_support` (house) | A1 free cash −1,000,000 |

**End state:** the money waits in the **self-support pool**, marked as house support (`source_table = partner_supported_houses`). No agent or landlord is paid, because there is no tenant.

> ⚠ **Not built yet:** when a tenant later moves into that house, nothing moves the money out of A21 yet. Until that hook exists, house money stays in A21 and is returned to treasury when the portfolio is redeemed. The books stay balanced; the money is simply idle.

---

## 4. After creation: what each later event moves

These apply to portfolios created **after** switch-on.

### Top-up

| Step | Goes UP | Goes DOWN | Pool |
|---|---|---|---|
| Partner submits a top-up of 200,000 | L6 +200,000 | Partner wallet −200,000 · L1 −200,000 | nothing yet |
| Top-up **applied** to the portfolio | L2 +200,000 · portfolio principal +200,000 | L6 −200,000 | **A21/A22 +200,000** · `landlord_pool_topup_<origin>` · A1 −200,000 |
| Top-up **cancelled** instead | Partner wallet +200,000 (refund) | L6 −200,000 | nothing |
| **Self-managed** top-up adding a tenant | as §2, for the new tenant | | as §2, under `landlord_pool_topup_self_support`, and deployed straight to the agent |

### Compounding (Returns reinvested instead of paid out)

| | Goes UP | Goes DOWN | Pool |
|---|---|---|---|
| Returns of 50,000 compounded | L2 +50,000 · portfolio principal +50,000 · Returns expense +50,000 | (nothing is paid to the wallet) | **A21/A22 +50,000** · `landlord_pool_compound_<origin>` · A1 −50,000 |

Compounding isn't new cash. It sets aside the treasury cash that would otherwise have been paid out as Returns.

Every top-up and every compounding event becomes **its own pool entry**. `v_landlord_pool_position` shows each portfolio split into **principal / topup / compound**.

---

## 5. When the pool money is used and comes back

### The CFO funds a company tenant's rent (600,000)

| | Goes UP | Goes DOWN |
|---|---|---|
| **Today** (unchanged) | A3 +600,000 · agent landlord float +600,000 | A1 −600,000 |
| **Pool** | A1 +600,000 · `landlord_pool_deploy_target` | **A22 −600,000**, oldest money first · `landlord_pool_deploy_company_managed` |

**Net:** A22 −600,000, A3 +600,000, free cash unchanged. If the pool holds only 400,000, it pays 400,000 and treasury covers the other 200,000.

This step lives in the `fund-agent-landlord-float` edge function. It was pushed in `43a0c5018e` and runs once that function is deployed.

### The tenant repays an instalment of 700,000 (principal 500,000 + fees 200,000)

| | Goes UP | Goes DOWN |
|---|---|---|
| **Today** (unchanged) | cash with agent (A5) · fees to revenue | A3 (the tenant owes less) |
| **Pool** | **A21/A22 +500,000**, principal only · `landlord_pool_return_<origin>` | A5 −500,000 · `landlord_pool_return_source` |

- **Only the principal** returns. Fees are Welile's revenue and never go to the pool.
- It goes back to the same origin that funded the tenant.
- A reversed collection takes its principal back out of the pool.

### Redemption

| Event | What moves |
|---|---|
| Partial redemption (principal lowered) | Pool money above "remaining principal − money out with tenants" is released: **A21/A22 down, A1 free cash up** (`landlord_pool_release_<origin>`) |
| Full redemption / cancellation | Everything still in the pool is released to A1. Money out with tenants is released as tenants repay it |
| Paying the partner | unchanged; paid from treasury by the existing redemption flow |
| Portfolio **matures** | nothing moves, because a matured portfolio can be renewed |

---

## 6. Summary for one portfolio of 1,000,000 at creation

| Portfolio type | Partner wallet | L2 owed to partner | A1 free cash | Pool | Tenant owes (A3) | Agent landlord float |
|---|---|---|---|---|---|---|
| **Company-managed** | −1,000,000 | +1,000,000 | −1,000,000 | **A22 +1,000,000** | — | — |
| **Self-support, tenant** | −1,000,000 | +1,000,000 | −1,000,000 | A21 in and out (net 0) | +1,000,000 | +1,000,000 |
| **Self-support, house** | −1,000,000 | +1,000,000 | −1,000,000 | **A21 +1,000,000** | — | — |
| *Any type, created before switch-on* | −1,000,000 | +1,000,000 | 0 (tenant type: −1,000,000) | none | as today | as today |

**Treasury figure** (`get_treasury_cash_position`):
- `total_cash` is now **free cash**. It drops by whatever sits in the pool.
- `landlord_pool_self_support`, `landlord_pool_company_managed` and `landlord_pool_total` show the pool.
- `total_treasury_incl_pool` is free cash plus the pool.

---

## 7. Where to look

| Question | Look at |
|---|---|
| How much is in the pool, by origin and by kind (principal / top-up / compound)? | `v_landlord_pool_position` |
| Every movement of one portfolio's pool money | `landlord_pool_entries` + `landlord_pool_movements` |
| Did any new portfolio miss the pool? | `v_landlord_pool_unreserved`, which must be empty |
| Did anything fail? | `landlord_pool_exceptions` where `resolved_at IS NULL`, which must be empty |
| Treasury position | `get_treasury_cash_position()` |

## Before switching on

1. **Deploy the edge function.** Confirm the `fund-agent-landlord-float` version from `43a0c5018e` is live.
2. **Brief finance** that free cash will drop by the pool total.
3. **Switch on:** `UPDATE treasury_controls SET enabled = true, value = now()::text WHERE control_key = 'landlord_pool_from';`
4. **Decide the house plan gap (§3)** before house-plan portfolios start filling A21.
