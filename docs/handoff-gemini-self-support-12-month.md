# Handoff for Gemini: self-support is now a 12-month contract

**Logic is done (Claude).** This is the UI side. Nothing here changes money.

## What changed in behaviour
- A self-support partner (tenant plans or houses) earns **15% a month for the whole 12-month contract**.
  The rent plan underneath no longer matters to the partner: when a tenant's plan completes, the
  partner keeps earning. The server owns the term (`psm_contract_term_months()` = 12); screens no
  longer send a term.
- The portfolio becomes **inactive (`matured`) automatically** when the contract ends.
- **The partner must not see anything about a rent plan completing.** They only know they are earning.

## What the partner dashboard should stop showing
| Where | What to hide / change |
|---|---|
| `src/components/partner/SelfPortfolioFundingCard.tsx` ~line 1678 | The `{plan.duration_days} days` chip on each plan card |
| `src/components/supporter/SupportedTenantDrawer.tsx` ~line 163 | The "Plan length" row |
| `src/components/supporter/SupportedTenantsSection.tsx`, `SupportedTenantDrawer.tsx` | Any plan status such as "completed" / "repaying" (`formatTenantStatus`). Show the support as ongoing. |
| `src/components/partner/SelfPortfolioPlanDetailSheet.tsx` | Plan length / repayment-schedule wording. (The projection number there already uses 12 months.) |
| `SelfPortfolioDeployDialog.tsx` | "monthly term" wording. Already says "12-month term" in one place; check the rest. |

## What to show instead
- One account for the contract: **"Month n of 12"**. Start = the commitment's first live date,
  end = `partner_self_commitments.term_end_at` (also `investor_portfolios.maturity_date`).
- Under it, the tenants / houses their money is supporting, without plan status or plan length.
- After the contract ends the portfolio shows **Matured** (already a known status in the app).

## Do not
- Do not call it "renewed" when money moves to new plans. "Renewal" already means extending a
  portfolio after maturity.
- Do not show the funding partner anywhere a landlord can see it (landlord SMS never names them).

## Data you can rely on
- `partner_self_commitments`: `term_months` (12), `term_end_at`, `next_payout_at`, `status`
  (`pending_ops_approval` -> `active` -> `matured`).
- `partner_self_funding_lines.plan_closed_at` is **ops-only**. Never display it.
