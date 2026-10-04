# Supporter / Funder System Reference Manual

Produce one new document, `docs/SUPPORTER_SYSTEM_ARCHITECTURE.md`, covering all 21 requested sections. Read-only: no code, SQL, migration, trigger, RPC, edge function, or config changes.

## What already exists to build on

- **~40 supporter/funder edge functions** already identified, including `activate-supporter`, `process-supporter-roi`, `create-investor-portfolio`, `portfolio-topup`, `approve-portfolio-topup`, `approve-pending-portfolio`, `apply-scheduled-portfolio-renewals`, `process-portfolio-renewal`, `process-investment-interest`, `angel-pool-invest`, `agent-angel-pool-invest`, `agent-invest-for-partner`, `coo-invest-for-partner`, `coo-wallet-to-portfolio`, `coo-create-portfolio`, `register-proxy-funder`, `reverse-proxy-roi-approval`, `submit-portfolio-action-request`, `submit-portfolio-completion`, `portfolio-topup-row-action`, `manager-portfolio-topup`, `supporter-account-action`, `send-funder-statement`, `activate-promissory-note`, `process-promissory-deductions`, `lookup-promissory-note`, `generate-partner-agreement`, `send-partner-agreement-with-pdf`, `send-supporter-agreement-email`, `submit-partner-form`, `import-partners`, `partner-ops-automation`, `create-portfolio-invite`, `create-supporter-invite`, `create-funder-onboarding-account`, `funder-confirm-account`, `coo-broadcast-partners`, `cto-broadcast-partners-sms`, `resend-partner-agreement-email`.
- **Frontend surface**: `src/components/supporter/`, `src/components/partner/`, plus pages `ActivateSupporter`, `ActivatePartner`, `BecomeSupporter`, `InvestmentPortfolio`, `InvestorPortfolioPublic`, `PartnerOnboarding`, `PartnersTerms`, `RegisterPartnerPublic`, `AgentPartners`, `SupporterEarnings`, `ReinvestmentHistory`.
- **Companion docs** to align with and cross-reference: `docs/FINANCIAL_SYSTEM_ARCHITECTURE.md` and `docs/AGENT_SYSTEM_ARCHITECTURE.md`.

## Research approach

Five parallel read-only research passes, each reporting exact table names, columns, RPC signatures, trigger names, cron schedules and file paths:

1. **Identity, lifecycle, onboarding** — supporter/partner registration and invite paths, funder onboarding + contract PDF, identity/KYC verification, activation, suspension, closure, proxy-funder registration, agreements and signatures.
2. **Portfolio engine** — `investor_portfolios` and related tables, creation, approval, funding, renewals, top-up parking/merge, completion, transfers, closure, history and state machine.
3. **ROI / growth engine** — accrual model, cycle and schedule logic, monthly flat-rate returns, partial ROI split (payout vs reinvest), Self Portfolio Management (PSM) accruals and `pay_partner_self_cycles`, angel pool, promissory notes, managed-proxy payout routing.
4. **Money movement** — deposits (MoMo, bank, cash receipts, Gmail auto-match), wallet buckets and permissions, withdrawals and the 90-day notice rule, standing orders / scheduled payouts, advance and default recovery from ROI, ledger categories and balanced-leg patterns.
5. **Security, ops and failure modes** — RLS and SECURITY DEFINER inventory, triggers and guards, funding double-debit protections, reconciliation views, cron job inventory and current health, dashboards, reports, and every known incident class.

## Document structure

Sections follow the requested numbering exactly:

1. Executive Summary — 2. Business Model — 3. Complete Lifecycle — 4. Account Structure — 5. Database Table Inventory (with Source of Truth / Projection / Cache / Snapshot / Audit / Config / Legacy classification per table) — 6. Edge Function Inventory — 7. RPC Inventory — 8. Funding Workflows — 9. Portfolio Engine — 10. ROI / Growth Engine — 11. Advance Recovery — 12. Wallet Interaction — 13. Ledger Interaction — 14. Dashboard Architecture — 15. Security Model — 16. Failure Modes — 17. Cron Jobs — 18. Financial Reporting — 19. End-to-End Workflow Diagrams — 20. Risk Assessment — 21. Appendices.

Conventions:

- Every claim cites a file path, table, function, trigger, or cron job name.
- Anything not directly observed is labelled **(inferred)**.
- Regulatory terminology throughout: "Supporter" (not lender), "Returns" (not ROI) in user-facing wording, "Rent Plan" (not loan); amounts as `UGX 50,000`.
- Section 19 contains the 12 requested Mermaid diagrams inline in the Markdown; a standalone `.mmd` artifact of the complete supporter lifecycle is also produced for visual review.

## Technical notes

- Schema, RPC, trigger and cron facts are gathered via read-only `psql` / read-query against the live database plus repo greps. `cron.job` may not be readable with the available role — if so the cron section is reconstructed from `cron.schedule(...)` calls in migrations and explicitly marked as such.
- Expected output size: roughly 1,500–2,500 lines, written in sequential appends so no single write is truncated.
- No files other than `docs/SUPPORTER_SYSTEM_ARCHITECTURE.md` (and the one diagram artifact) are created or modified.
