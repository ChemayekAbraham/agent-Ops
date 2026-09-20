# Complete the Funder top-right menu

## Goal
Make every action previously available on the Funder dashboard or its header reachable from the top-right menu, without changing any funding, wallet, portfolio, or access logic.

## Changes
- Make “Houses without tenants” open the existing vacant-house view instead of the ready-tenant view.
- Keep “Houses with ready tenants” opening the existing ready-tenant view.
- Add the previously available header actions to the drawer: profile, notifications, install/share app, careers, and sign out.
- Preserve existing dialogs and destinations for funding, wallet, portfolios, supported houses, Returns, statements, receipts, agreements, settings, marketplace, referrals, and help.
- Use the same existing handlers, routes, permission checks, and data sources; only menu wiring changes.

## Verification
- Open every menu item in the authenticated preview and confirm the intended page, drawer, dialog, or house list appears.
- Confirm profile picture and AI ID remain visible on the main page.
- Confirm no payment, wallet, ledger, or backend logic changes.
