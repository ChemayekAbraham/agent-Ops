# Receivables Analysis page (CFO)

Clicking the Total Receivables card opens a full-page, read-only **Receivables Analysis** view (`/cfo/receivables`), replacing the removed pop-up sheet. Nothing about balances, Rent Plans, wallets or the ledger changes.

## Layout (top to bottom)

1. **Header row** — page title, back link, Receivable Category dropdown (loaded from the live breakdown, not hard-coded), compact filter bar: Country, Region, District, Sub-county, Village, Status, Overdue/Current, due-date range.
2. **Current position** — one quiet strip of six figures: Total Outstanding, Current/Not yet due, Overdue, Due in 7 days, Collection rate, Number of accounts.
3. **Where it comes from** — breadcrumb drill (Country → Region → District → Sub-county → Village) above one sortable, filterable, paginated table: count, outstanding, overdue, % of total, average, collection performance. Clicking a row goes one level deeper.
4. **Underlying receivables** — at village level (or any row's "View records"), a paginated table of individual items: name, category, outstanding, original, collected, overdue, due date, days outstanding, location columns, agent.
5. **Projection** — period chips (7 days, 1, 3, 6, 9 months, 1 year, 2 years), a line chart with solid Actual and dashed Projected lines, and a summary table: expected collections, outstanding, overdue, collection period, number of collections, cash inflow. Shows "Insufficient data" when the model reports low or no quality, rather than a number.

Neutral background, subtle dividers, right-aligned tabular UGX figures, restrained colour used only for status. No pop-ups stacked on pop-ups.

## Data sources (reuse first)

- Totals and categories: existing `get_receivables_total` / `get_receivables_breakdown`.
- Tenant location drill and accounts: existing `useTenantReceivablesByLocation` / `useTenantReceivableAccounts`.
- Projection: existing `get_receivables_predictive_forecast` (Actual vs Projected and quality bands are already built in).
- Gap: the location drill only covers tenant receivables. A new read-only, role-gated function `get_receivables_by_location(category, level, filters)` would extend the same location grouping to other categories (agent, landlord, partner, service centre). It would read the same authoritative receivable items, so totals still tie out to the card. Where a category has no location data, its rows show "Unassigned location" and are never guessed.
- Due-in-7-days / overdue / current split come from item due dates already in the breakdown; if a category lacks due dates, that figure shows "Insufficient data".

## Technical details

- New route `/cfo/receivables` (CFO role-gated like the dashboard); the card in `CFOReceivablesPayablesHome.tsx` becomes a link to it.
- New files: `src/pages/cfo/ReceivablesAnalysis.tsx`, components under `src/components/cfo/receivables-analysis/` (CategorySelect, FilterBar, PositionStrip, LocationDrillTable, RecordsTable, ProjectionSection), filter state kept in the URL query so drill steps can be shared and the back button works.
- One additive migration for `get_receivables_by_location` (SECURITY DEFINER, `receivables_guard()`, `search_path = public`, anon revoked), verified against the live schema first; it checks that the location total equals `get_receivables_total` for the category.
- Projection periods map to the existing function: 7 days → day×7, 1–9 months → week/month, 1–2 years → month×12/24.
- Read-only throughout; `npm run guard:all` run before finishing.
