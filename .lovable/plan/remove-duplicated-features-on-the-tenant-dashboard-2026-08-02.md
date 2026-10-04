# Remove duplicated features on the Tenant dashboard

The tenant home screen and the Menu drawer currently render several of the same cards and actions. The rule below decides which surface keeps each feature; the duplicate copy is deleted.

Rule: the home screen keeps discovery and growth cards; the Menu drawer keeps navigation and money tools only, with no repeated home cards.

## Confirmed duplicates

1. Find a house CTA — rendered three times: home screen, inside the Menu drawer's extra content, and as the Menu item "Available Houses — Daily Rent". All three open the same houses sheet.
   Keep the home screen card and the Menu item. Delete the copy inside the drawer's extra content.
2. Suggested houses card — on the home screen and again inside the Menu drawer's extra content. Keep home screen, delete drawer copy.
3. Invite & Earn card — on the home screen (compact) and again inside the drawer (full). Keep the home screen compact one, delete the drawer copy.
4. Repayment section — rendered twice inside the drawer: once automatically for funded/repaying tenants and once again when the "My Repayment Schedule" menu item toggles it. Collapse to a single instance so the schedule can never appear twice.
5. Menu "Help & Support" and Menu "Settings" both navigate to /settings. Keep Settings, remove the duplicate Help & Support entry.

## Dead code removed at the same time

The large bread hero block on the tenant dashboard is wrapped in `{false && ( ... )}`, so roughly 270 lines never render. Removing it also removes the state and imports used only by it: the bread/rental image imports, `breadLoaded`, `breadError`, `rentalsLoaded`, `heroSlideIndex`, `heroScrollerRef`, `freeBreadsInfoOpen`, and the rental preload effect. The Rent Fees price data (`breadPrice`) and receipt history stay — still used by the rent discount carousel and the "Recent receipts" card.

## Technical notes

- Files touched: `src/components/dashboards/TenantDashboard.tsx`, `src/components/tenant/TenantMenuDrawer.tsx`.
- Presentation only: no schema, RPC, or business-logic change.
- Dialog/sheet wiring (wallet sheet, pay landlord, payment partners, houses sheet, claim dialogs) stays intact. The claim/receipt/share buttons inside the dead block are unreachable today and go away with it; the reachable receipt entry points remain.
- Unused imports and state in both files are cleaned so the typecheck stays clean.