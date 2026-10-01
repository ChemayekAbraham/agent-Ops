# Shopping Advance user dossier

## Goal
Replace the current flat selected-user details in Agent Ops → Welile Shopping Advance with a responsive, tabbed dossier that brings together the user’s system identity, Rent Plan balances, advances and obligations, partnerships, shares, and AI ID information.

The qualification list, geographic drill-down, and Shopping Advance calculation remain unchanged.

## User experience
- Keep the current qualified-user count, location browsing, and name/phone search.
- Opening a user shows a clear summary header with name, Welile AI ID, roles, verification state, location, and membership activity.
- Show responsive summary figures for total Rent Plan balance, active advances, total obligations, partnership value, and shares.
- Organize details into tabs:
  - **Overview:** contact, location, account status, wallet summary, and recent activity.
  - **Rent Plans:** every relevant Rent Plan, amount, paid amount, outstanding balance, status, agent, and dates.
  - **Advances & obligations:** Shopping Advance access, agent/business advances, outstanding balances, repayment state, and other recorded obligations.
  - **Partnerships & shares:** Supporter portfolios, principal, Returns, maturity/status, Angel Pool shares, and related holdings when the viewer is authorized.
  - **AI ID:** Trust Score, tier, access limit, payment history, cash-flow capacity, network, verification, behavior, landlord, and agent-performance details already available under AI ID.
- Use clear empty, loading, restricted, and error states per tab so one slow section does not block the whole dossier.
- Mask National ID and mobile-money details by default. Only roles already authorized by the server may reveal them.
- Keep the layout responsive on phones, tablets, desktop sheets, and wide screens.

## Data and safety
- Add a dedicated, read-only, server-authorized Shopping Advance dossier function rather than issuing many browser queries.
- Verify the live schema and existing functions before writing any migration.
- Reuse authoritative calculations and existing role gates where possible; do not recreate wallet, Rent Plan, advance, partnership, share, or Trust Score logic in the browser.
- The server must enforce the existing Agent Ops/executive allowlist and independently restrict Supporter financial details and sensitive identity fields.
- Return a structured response in one request, with independently renderable sections and explicit restricted flags.
- Read wallet values through the existing strict wallet source; never derive financial balances from display caches alone.
- Treat Shopping Advance as an informational access limit unless an authoritative issuance/repayment record exists; do not label the access limit as money already advanced.
- Do not expose full ledger rows, internal fraud notes, passwords, authentication data, or unrestricted financial data.
- This feature is read-only: no wallet, ledger, payment, Rent Plan, advance, portfolio, share, status, or approval writes.
- Opening or browsing the dossier must not emit financial transactions or call settlement/payment functions.

## Technical changes
- Add a focused hook and types for the one-request user dossier.
- Add a dedicated tabbed dossier component and connect it only to the selected-user state in the existing Shopping Advance sheet.
- Preserve the existing qualification RPC and list behavior.
- Add one backend migration for the role-gated read-only dossier function, with PUBLIC/anon execution revoked and authenticated execution granted.
- Use semantic design tokens and existing UI components; do not hardcode colors.
- Add the architectural decision to `AGENTS.md`.

## Verification
- Test authorized and unauthorized roles, restricted partnership visibility, masked/reveal behavior, missing-data states, and responsive layouts.
- Confirm the qualified-user population and ordering are unchanged.
- Confirm the dossier makes one consolidated data request per selected user and caches it appropriately.
- Confirm opening every tab produces no database writes and no payment/settlement calls.
- Verify displayed Rent Plan outstanding balances, advance balances, partnership totals, shares, and AI ID figures against authoritative live records for representative users.
- Run focused tests, TypeScript checks, `npm run guard:all`, `git diff --check`, and inspect the preview build log.
- Do not publish.
