# Tenant-centric Funder dashboard

## What will change

- Keep the profile picture, name and AI ID visible near the top.
- Make **Support tenants directly** the main dashboard view instead of the current wallet, promotion and portfolio stack.
- Default to **Houses with ready tenants**, with a clear switch to **Houses without tenants yet**.
- Make each opportunity image-first, using the existing house photo and keeping every current amount, status, selection, detail and funding action unchanged.
- Consolidate wallet, portfolios, calculator, managed support, Angel Pool, supported houses, referrals, statements, receipts, marketplace, agreements and settings into the existing top-right menu.

## Implementation

- Recompose `SupporterDashboard` so only identity and the direct-support catalogue remain in the main scrolling view.
- Let `FunderCapitalOpportunities` open directly in its existing direct-support mode when embedded as the dashboard focus, while retaining its other modes for menu access.
- Update the existing ready-tenant and empty-house cards to use a strong 4:3 house image with details below.
- Extend the Funder menu with callbacks to every feature removed from the main page, preserving the existing dialogs, drawers, navigation and permission gates.
- Use existing semantic colours, buttons and data sources only; no backend, financial, funding or access logic changes.

## Validation

- Check desktop and mobile layouts on `/dashboard/funder`.
- Confirm ready tenants load first and the vacant-house switch works.
- Confirm every moved feature remains reachable from the top-right menu.
- Confirm house details, selection, funding, calculator, wallet and portfolio flows still open correctly.
- Run the project guards and inspect the current preview build status.
