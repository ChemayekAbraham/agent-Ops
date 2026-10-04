# Partnership Operations — Phase 1

## Current state (verified)

- Every funder investment lands **active immediately**. `investor_portfolios` holds 1,011 `active`, 7 `awaiting_partner_details`, 6 `cancelled` — there is **no** partner-created "pending approval" state today.
- Self-managed support (`partner_self_confirm_commitment`) debits the wallet and posts ledger legs in the same call, so money leaves instantly with no ops review.
- `approve_pending_portfolio` already exists and accepts `pending_ops_approval`, but nothing ever writes that status from the funder side.
- Agreement records exist (`supporter_agreement_acceptance`, `partner_agreements`) but are only used to unlock UI panels — they do not block portfolio creation.
- Supported tenants for a funder are `rent_requests` rows where `supporter_id = funder`; the dashboard already loads them as "virtual houses" but shows anonymised short IDs only.

## What to build

### 1. Pending-first portfolios

- Funder-initiated portfolio creation (support-a-tenant and self-support) creates the portfolio with status `pending_ops_approval`.
- No wallet debit and no ledger legs at creation. Capital is only **reserved** (a hold), so the funder's withdrawable balance shows the money as committed but the portfolio is inactive.
- On Partner Ops approval: the existing `approve_pending_portfolio` path flips it to `active`, and only then does the wallet debit + ledger posting run.
- On rejection: the hold is released, claimed rent plans return to the queue, and the funder is told why.
- Funder dashboard shows an "Awaiting approval" state on those portfolios so nobody thinks their money vanished.

### 2. Contract gate

- A funder cannot create a portfolio without a signed agreement record.
- Checked server-side inside the creation RPC (not just the UI) so it cannot be bypassed.
- Blocked attempts return a clear message: no silent failure, no generic error. The dashboard turns that into a "Sign your partner agreement to start funding" prompt with a direct link to the agreement.

### 3. Partner Ops dashboard: pending portfolios tile

- Replace the **Total Funded** summary tile on the Partner Ops overview with a **Pending Portfolios** tile: count of portfolios awaiting approval, total value awaiting, and oldest wait in days.
- Amber above 0 pending, red when anything has waited more than 2 days.
- Tapping it opens the pending-approval queue with approve / reject per row (reject requires a reason).

### 4. Funder dashboard: supported tenants section

New section directly below the wallet card, titled "Tenants you support".

- One row per supported tenant: full unblurred avatar, full name, address, and the amount funded.
- Tapping a row opens a full drawer with the complete tenant detail — **no repayment history shown**.
- Search across name and address.
- Pagination at 10 per page.
- When the funder supports fewer than 10 tenants, the search box, filters and pagination controls are hidden entirely — just the list.

### 5. Wallet card: tenants count

- On the funder wallet hero card, the "Houses" tile becomes **Tenants** with the count of supported tenants. Tapping it scrolls to the new supported-tenants section.

## Technical notes

- New RPCs: `funder_create_pending_portfolio` (contract gate + hold + `pending_ops_approval`), `reject_pending_portfolio` (reason-required, releases hold and claims). `approve_pending_portfolio` extended to perform the deferred wallet debit and ledger posting via the existing `create_ledger_transaction` path — no direct wallet writes.
- `partner_self_confirm_commitment` is split: commitment creation stays, the debit/ledger block moves behind approval.
- Contract check reads `partner_agreements` for partner-role funders, falling back to `supporter_agreement_acceptance` for supporters, and raises a typed exception (`AGREEMENT_REQUIRED`) the client maps to a friendly message.
- Every transition emits a `system_events` row and an `audit_logs` entry with reason.
- Frontend files touched: `src/components/dashboards/SupporterDashboard.tsx`, `src/components/wallet/UnifiedWalletHeroCard.tsx`, `src/components/coo/COOPartnersPage.tsx` (tile swap), `src/components/executive/PartnersOpsDashboard.tsx`, plus new `SupportedTenantsSection.tsx`, `SupportedTenantDrawer.tsx` and `PendingPortfoliosQueue.tsx`.
- Existing 1,011 active portfolios are untouched — the new status applies to new creations only.
