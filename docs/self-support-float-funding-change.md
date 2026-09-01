# Self Support funding source change: operational float, not withdrawable balance

Status: IMPLEMENTED 2026-09-01 (Phase 1 — gates, ledger buckets and tags applied; see mem://business-model/self-support-float-funding)
Scope: Funder (Partner) dashboard → Self Portfolio Management ("Self Support") only
Date raised: 2026-09-01

## 1. What changes

Today a funder creating a self-managed portfolio spends from their **withdrawable
balance**. Every gate — the "Available to fund" figure, the per-plan selection check,
and the release step — reads the strict withdrawable figure.

The new rule: a funder creating a self-support portfolio spends from their
**operational float bucket** (`wallets.float_balance`), not from withdrawable.

Withdrawable balance stays what it is: the funder's own cash-out money. Float is
company/operational money placed with the funder for deployment, and deploying it into
rent plans and empty houses is exactly a deployment, not a cash-out.

## 2. Why this is a rule change worth writing down

Standing platform rule (Wallet 3-bucket model):

- `withdrawable_balance` — funder's own money, the only bucket a withdrawal may draw.
- `float_balance` — company money placed with the holder, **never withdrawable**.
- `advance_balance` — liability, auto-recovered.

Self Support currently draws from bucket 1. This change moves it to bucket 2. That is a
deliberate, temporary relaxation of "float is only for field disbursement": float may now
also be consumed to create a funder portfolio. It must therefore be **tagged** so nobody
later has to guess how a float drawdown was consumed.

## 3. Tagging float consumption (the important part)

Every float drawdown that creates a portfolio must be labelled at the point of posting, so
float usage is auditable by purpose:

- Ledger legs carry a float-usage tag, e.g. `float_usage = 'self_portfolio_funding'`,
  alongside the existing `wallet_bucket = 'float'` and the source portfolio /
  rent-request / house reference.
- Proposed tag vocabulary for float consumption:
  - `landlord_disbursement` — existing field/rent disbursement use
  - `self_portfolio_funding` — NEW: float consumed to create a self-managed portfolio
  - `house_support_funding` — NEW: float consumed to support an empty house
  - `correction` — reversals and admin corrections
- Reporting consequence: CFO / FinOps can answer "of the float outstanding with funders,
  how much is sitting in field float vs locked inside self-managed portfolios?" without
  reconstructing it from narratives.

## 4. Impact

**Funder dashboard (`SelfPortfolioFundingCard`, `SelfPortfolioDeployDialog`)**
- "Available to fund" becomes the float figure, not withdrawable.
- All copy changes from "withdrawable balance" to "operational float".
- A funder with float but no withdrawable can now fund; a funder with withdrawable but no
  float can no longer fund this way. Expect support questions on the second case.

**Backend gates (behaviour, not yet changed)**
- `partner_self_list_fundable_plans` — `available_balance` should report float.
- `partner_self_confirm_commitment` / `partner_self_top_up` — capacity check and the debit
  leg move to the float bucket, tagged per §3.
- `partner_self_topup_eligibility` — same source swap.
- Routing must respect the recipient-type rule: float legs stay float; nothing here may
  silently promote money into withdrawable.

**Returns / ROI**
- Unchanged in rate and cadence. But note the asymmetry to decide explicitly:
  principal came from float, while returns pay into **withdrawable**. That converts company
  float into funder-withdrawable earnings over time, which is intended for returns but must
  never apply to the principal. On redemption/exit, principal must return to **float**, not
  to withdrawable.

**Solvency and reporting**
- Float outstanding no longer equals "cash with agents for disbursement". Float reports and
  the treasury position need the new tag to keep the two uses apart.
- Withdrawable-drift and float-limit monitors will see float drawdowns of a shape they have
  not seen before; thresholds should be reviewed once volumes appear.

**Audit**
- Each portfolio creation should be traceable to: funder, float amount consumed, tag,
  plan/house funded, and actor — reusing the existing ledger + audit trail, no new system.

## 5. Explicitly out of scope

- No change to approval rules, ROI rate, portfolio lifecycle, or default absorption.
- No change to the withdrawal gate: float remains non-withdrawable.
- No deletion or rewrite of historical portfolios funded from withdrawable; they stay as
  posted and are distinguishable by the absence of the new tag.

## 6. Open decisions before implementation

1. Redemption of a float-funded portfolio: principal back to float (recommended) —
   confirm.
2. Funders holding both buckets: float-only, or float-first then withdrawable? (float-only
   is simpler and matches the stated rule).
3. Should Partner Ops be able to see a funder's float-funded portfolio total as a separate
   figure on the partner profile?
