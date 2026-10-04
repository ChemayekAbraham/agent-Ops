# Shopping Advance User Dossier

## Goal
Turn each qualified-user entry under Agent Ops → Welile Shopping Advance into a complete, read-only user dossier while preserving the existing qualification list and rules.

## User experience
- Keep the current qualified-users list, search, filters, sorting, and export unchanged.
- Selecting a user opens a dedicated dossier rather than overloading the list row.
- Show an identity header with name, roles, Welile AI ID, verification/frozen state, contact details, location, membership date, last activity, and wallet-transfer qualification evidence.
- Organize details into clear tabs:
  - **Overview:** key identity and qualification facts, current access limit, and high-level financial exposure.
  - **Rent Plans:** each Rent Plan, status, total payable, paid amount, outstanding balance, daily amount, assigned agent, and dates.
  - **Advances & obligations:** active/pending Agent Advances, Business Advances, and CFO debit obligations with principal, outstanding amount, status, and dates.
  - **Partnerships & shares:** Supporter portfolios and Angel Pool shares, statuses, contributions, ownership, maturity, and Returns earned where authorized.
  - **AI ID:** the existing Welile AI ID trust profile, score/risk data, payment behavior, wallet/network signals, referrals, and other available trust details.
- Mask sensitive monetary and contact values by default, with an explicit reveal control.
- Use responsive summary cards: four columns on wide desktop, two on tablet, and one on mobile.
- Provide honest empty, loading, unavailable, and permission-denied states instead of displaying missing data as zero.

## Data and safety
- Add one role-gated, read-only server function that returns the dossier in one request to avoid duplicate queries and inconsistent snapshots.
- Restrict access to the same Agent Ops/management roles already allowed to view qualified Shopping Advance users.
- Reuse authoritative sources:
  - `agent_ops_shopping_advance_qualified_profiles` for qualification evidence.
  - `derive_welile_ai_id` and `get_user_trust_profile` for Welile AI ID data.
  - `get_user_available_balance` and wallet projections for wallet figures.
  - `rent_requests`, `agent_advances`, `agent_advance_requests`, `business_advances`, `cfo_debit_obligations`, `investor_portfolios`, and `angel_pool_investments` for the relevant records.
- Calculate the displayed Shopping Advance access limit from the existing 2× transfer-growth rule, starting at UGX 30,000 and capped at UGX 30,000,000; label it as informational access, not issued funds.
- Never write wallet, ledger, advance, Rent Plan, partnership, share, user, or workflow data. Opening or viewing the dossier emits no financial transaction or approval action.
- Keep regulated wording: **Rent Plan**, **Supporter**, and **Returns**.

## Implementation scope
- Extend `ShoppingAdvanceQualifiedUsersSheet` only to open the dossier from an existing user row/card.
- Add a focused Shopping Advance dossier component and data hook; do not alter unrelated Agent Ops panels.
- Add a migration for the read-only dossier function with explicit grants, server-side role validation, and no anonymous execution.
- Record the one-request dossier architecture in `AGENTS.md`.
- Add focused tests for limit calculation, sensitive-value masking, empty-state handling, and qualification-list preservation.

## Verification
- Run the TypeScript check, relevant tests, `npm run guard:all`, and confirm the preview build is clean.
- Verify desktop and mobile dossier layouts in the live preview.
- Confirm opening, searching, tabbing, masking/revealing, and closing the dossier creates no non-read request and no wallet, ledger, approval, settlement, or status change.
- Leave the app unpublished.
