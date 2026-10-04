# Category → account map

Complete `ledger_account_map`, **113 rows, as at 2026-09-24**.

`*` = bucket-agnostic. **Bucket-specific rows win** over bucket-agnostic ones.
`debit_when` is the `direction` value that makes a leg a **debit**.

> This is the accounting policy, not a lookup table. Changing a row re-states
> every historical leg that resolves through it. Read the checklist at the end
> before editing.

---

## Assets

### A1 — Cash and Bank Balances

| Scope | Bucket | Category | `debit_when` |
|---|---|---|---|
| platform | * | `agent_landlord_payout` | cash_in |
| platform | * | `cash_at_bank_reclass` | cash_in |
| platform | * | `partner_capital_cash_received` | cash_out |
| platform | * | `rent_disbursement` | cash_in |
| platform | * | `treasury_bank_deposit` | cash_in |
| platform | * | `verified_bank_cash_recognised` | cash_in |
| platform | * | `wallet_deposit` | cash_out |
| platform | * | `wallet_transfer` | cash_out |
| platform | * | `wallet_withdrawal` | cash_out |

### A2 — Cash at Hand, Float with Agents

| Scope | Bucket | Category | `debit_when` |
|---|---|---|---|
| platform | * | `agent_facilitated_capital_receivable` | cash_out |
| platform | * | `agent_float_cash_offset` | cash_in |
| wallet | * | `agent_float_assignment` | cash_in |
| wallet | * | `agent_float_deposit` | cash_in |
| wallet | * | `agent_float_settlement` | cash_in |
| wallet | * | `agent_float_topup` | cash_in |
| wallet | * | `agent_float_used_for_rent` | cash_in |
| wallet | **float** | `bucket_reclass_in` | cash_in |
| wallet | **float** | `bucket_reclass_out` | cash_in |
| wallet | * | `proxy_partner_withdrawal` | cash_in |
| wallet | * | `rent_float_funding` | cash_in |
| wallet | * | `rent_payment_for_tenant` | cash_in |

### A3 — Rent Access Receivables (Tenants)

| Scope | Bucket | Category | `debit_when` |
|---|---|---|---|
| bridge | * | `fee_receivable_created` | cash_in |
| bridge | * | `rent_plan_receivable_restatement` | cash_in |
| bridge | * | `rent_receivable_created` | cash_in |
| platform | * | `agent_float_used_for_rent` | cash_in |
| platform | * | `pool_rent_deployment` | cash_out |
| platform | * | `rent_repayment` | cash_out |
| platform | * | `tenant_repayment` | cash_out |
| platform | * | `tenant_repayment_collected` | cash_in |

### A4 — Other Agent Receivables

| Scope | Bucket | Category | `debit_when` |
|---|---|---|---|
| platform | * | `agent_repayment` | cash_out |
| platform | * | `wallet_deduction` | cash_out |
| platform | * | `wallet_deduction_cash_payout_retraction` | cash_out |
| platform | * | `wallet_deduction_general_adjustment` | cash_out |
| wallet | * | `advance_repayment` | cash_in |

### A5 — Cash in Transit

| Scope | Bucket | Category | `debit_when` |
|---|---|---|---|
| platform | * | `cash_in_transit_banked` | cash_in |
| platform | * | `cash_receipt_in_transit` | cash_in |

### A6 / A7 — Landlord and Partner Product Receivables

| Acct | Scope | Bucket | Category | `debit_when` |
|---|---|---|---|---|
| A6 | bridge | * | `landlord_receivable_created` | cash_in |
| A6 | platform | * | `landlord_receivable_collected` | cash_out |
| A7 | bridge | * | `partner_receivable_created` | cash_in |
| A7 | platform | * | `partner_receivable_collected` | cash_out |

### A8 — Agent and Merchant Float Cycle Control

| Scope | Bucket | Category | `debit_when` |
|---|---|---|---|
| platform | * | `agent_float_assignment` | cash_in |
| platform | * | `agent_float_cycle_settled_to_bank` | cash_in |
| platform | * | `agent_float_deposit` | cash_in |
| platform | * | `agent_float_funding` | cash_in |
| platform | * | `agent_float_settlement` | cash_in |
| platform | * | `agent_float_topup` | cash_in |

### A9 — Suspense (debit)

| Scope | Bucket | Category | `debit_when` |
|---|---|---|---|
| bridge | * | `orphan_reassignment` | cash_in |
| bridge | * | `orphan_reversal` | cash_in |

Plus **every unmapped non-wallet leg**, which lands here silently.

### A10–A19 — the receivable subledgers

| Acct | Scope | Bucket | Category | `debit_when` |
|---|---|---|---|---|
| A10 | bridge | * | `agent_advance_receivable_opening` | cash_in |
| A10 | platform | * | `agent_advance_repayment` | cash_out |
| A11 | bridge | * | `agent_access_fee_receivable_opening` | cash_in |
| A12 | bridge | * | `merchandise_recovery_receivable_opening` | cash_in |
| A12 | platform | * | `merchandise_recovery_repayment` | cash_out |
| A12 | platform | * | `smartphone_advance_receivable` | cash_out |
| A13 | bridge | * | `bike_recovery_receivable_opening` | cash_in |
| A13 | platform | * | `bike_recovery_repayment` | cash_out |
| A14 | bridge | * | `credit_draw_receivable_opening` | cash_in |
| A14 | platform | * | `credit_draw_repayment` | cash_out |
| A15 | bridge | * | `merchandise_credit_sale_receivable_opening` | cash_in |
| A16 | bridge | * | `service_centre_advance_receivable_opening` | cash_in |
| A17 | bridge | * | `service_centre_receivable_opening` | cash_in |
| A18 | bridge | * | `tenant_service_charge_receivable_opening` | cash_in |
| A19 | bridge | * | `business_advance_receivable_opening` | cash_in |

---

## Liabilities

### L1 — Wallet Custody Payable

| Scope | Bucket | Category | `debit_when` |
|---|---|---|---|
| platform | * | `cash_custody_payable` | cash_in |
| platform | * | `roi_wallet_credit` | cash_out |
| wallet | **withdrawable** | `bucket_reclass_in` | cash_in |
| wallet | **withdrawable** | `bucket_reclass_out` | cash_in |
| wallet | **float** | `partner_funding` | cash_out |
| wallet | * | `partner_funding` | cash_out |
| wallet | * | `supporter_rent_fund` | cash_out |
| wallet | **withdrawable** | `tenant_rent_settlement` | cash_out |

**Plus the wallet fallback**: any wallet leg with no matching row resolves to L1
(except `float` → A2 and `advance` → A4).

### L2–L7

| Acct | Scope | Bucket | Category | `debit_when` |
|---|---|---|---|---|
| L2 | bridge | * | `partner_funding` | cash_out |
| L2 | bridge | * | `supporter_facilitation_capital` | cash_out |
| L2 | platform | * | `partner_funding` | cash_out |
| L2 | platform | * | `partner_receivable_capital` | cash_in |
| L2 | platform | * | `roi_reinvestment` | cash_out |
| L3 | platform | * | `partner_reward_accrued` | cash_in |
| L4 | platform | * | `landlord_receivable_obligation` | cash_in |
| L5 | platform | * | `agent_commission_accrued` | cash_in |
| L5 | platform | * | `agent_commission_settled` | cash_out |
| L6 | platform | * | `pending_portfolio_topup` | cash_out |
| L7 | platform | * | `treasury_allocated` | cash_in |
| L7 | platform | * | `treasury_fee_drawdown` | cash_out |
| L7 | platform | * | `treasury_fee_recognised` | cash_in |

---

## Equity

| Acct | Scope | Bucket | Category | `debit_when` |
|---|---|---|---|---|
| E1 | platform | * | `pool_capital_received` | cash_out |
| E1 | platform | * | `share_capital` | cash_out |
| E3 | platform | * | `balance_correction` | cash_out |
| E3 | platform | * | `historical_balance_reseed` | cash_out |
| E3 | platform | * | `receivable_restatement_equity` | cash_in |

**E4 has no mapping rows. It is resolver-injected only — never post to it.**

---

## Revenue and expense

### R1 — Platform Revenue

| Scope | Bucket | Category | `debit_when` |
|---|---|---|---|
| platform | * | `access_fee_collected` | cash_out |
| platform | * | `listing_rejection_recovery` | cash_out |
| platform | * | `registration_fee_collected` | cash_out |
| platform | * | `tenant_access_fee` | cash_out |
| platform | * | `treasury_net_revenue` | cash_in |

### X — expenses

| Acct | Scope | Bucket | Category | `debit_when` |
|---|---|---|---|---|
| **X1** | platform | * | `agent_bonus`, `equipment_expense`, `general_admin_expense`, `interest_expense`, `manager_credit`, **`marketing_expense`**, `payroll_expense`, `platform_expense`, `research_development_expense`, `salary_payout`, `supporter_platform_rewards`, `tax_expense` | cash_out |
| X2 | platform | * | `roi_expense` | cash_out |
| **X3** | bridge | * | `agent_commission` | cash_out |
| **X3** | platform | * | `agent_commission_earned` | cash_out |
| **X3** | platform | * | `agent_commission_payable` | cash_out |
| **X3** | platform | * | `agent_commission_payout` | cash_out |
| X4 | platform | * | `platform_loss_writeoff` | cash_out |
| X5 | platform | * | `merchant_oop_reimbursement` | cash_out |

---

## Agent-earnings categories: which expense account you land in

This trips people up, because two similar-looking bonus paths expense to
different accounts.

| Paid by | Wallet leg category | Platform leg category | Resolves to |
|---|---|---|---|
| Collection commission (10% / 8% / 2%) | `agent_commission_earned` | `agent_commission_payable` | **DR X3** / CR L1 |
| Funding bonus in `fund-agent-landlord-float` | `agent_commission_earned` | `agent_commission_earned` | **DR X3** / CR L1 |
| `credit_agent_event_bonus` (event bonuses) | `agent_commission` | `marketing_expense` | **DR X1** / CR L1 |
| `pay_landlord_registration_verified_bonus` | `agent_commission` | `marketing_expense` | **DR X1** / CR L1 |
| `pay_lc1_registration_verified_bonus` | `agent_commission` | `marketing_expense` | **DR X1** / CR L1 |
| 1% landlord-payout commission | `agent_commission_earned` | **`marketing_expense`** | **DR X1** / CR L1 |

> The wallet leg has no map row for `agent_commission` / `agent_commission_earned`
> at `withdrawable`, so it takes the wallet fallback to **L1**. The expense side
> is decided entirely by the **platform** leg's category.

**Consequence worth knowing:** agent commission is split across X1 and X3
depending on which function paid it. Anything reporting "what we pay agents" must
sum both, or the categories must be aligned deliberately.

---

## Unmapped categories seen in the wild

| Category | Status |
|---|---|
| `recruiter_override` | **not mapped** — would resolve to A9. Zero legs have ever carried it |
| `merchandise_revenue` | **not mapped** — resolves to A9 |

---

## Before you change a row

1. Is the account **resolver-affected**? (see `resolver.md` §safe/unsafe)
2. **`grep -rn "<category>" supabase/functions/`** — `balancedLedgerPost.ts`
   prices legs against this map over PostgREST and refuses to write an
   unbalanced group. A pg_proc scan cannot see it. On 2026-09-24 a mapping
   change passed every database-side check and would have rejected four live
   money paths; it was caught and rolled back 30 minutes later.
3. Will every affected group still balance on **base mapping alone**?
4. Does any affected group carry a **treasury category**
   (`treasury_fee_recognised`, `treasury_allocated`, `fee_receivable_created`,
   `partner_reward_accrued`, `agent_commission_accrued`, `treasury_net_revenue`)?
   Those **raise**, not log.
5. Re-run the four-partition trial balance afterwards.
