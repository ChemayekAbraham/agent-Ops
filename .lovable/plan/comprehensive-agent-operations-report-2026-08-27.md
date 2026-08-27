# Comprehensive Agent Operations Report

## Goal
Add one date-driven, exportable Agent Operations report that reconciles to existing operational records and definitions without changing any financial workflows.

## Report experience
- Add a **Comprehensive Report** action to the Agent Operations dashboard.
- Provide presets for Today, Yesterday, Last 5 days, Last 7 days, Weekend, This month, This year, and Custom range.
- Render a responsive financial-operations HTML report with print/export support and clear generated-at and selected-period labels.
- Organize the report into five report pages/sections:
  1. **Overview** — all agents, rent-active agents, sub-agents, collections, active-book pending amount, tenants collected vs not collected.
  2. **Rent Collections** — collected, expected, missed/shortfall, new requests and volume; agent collected-vs-expected table; daily paid/expected/missed chart; best five and highest-missed five agents; reconciled totals.
  3. **Agent Advances** — volume and status measures, agents with advances, recovery rate; daily recovered-vs-missed chart; top paying and overdue agents.
  4. **Service Centers** — request status totals, approved volume, receivables and repayments; approved-centre table with all assigned agents, phones, location, requested date and financial totals.
  5. **Agent Products & Services** — product/category KPIs, expected-vs-collected amounts, pending/approved/rejected applications, brand/product breakdowns, and performance using the existing Agent Leaderboard ranking logic.

## Data integrity and performance
- Add one authorized read-only backend report function accepting start/end dates and returning one JSON payload for all sections.
- Derive “agent” from having at least one assigned rent request, and “sub-agent” from existing parent-child relationships; deduplicate people in “all agents”.
- Use `agent_collections` for actual rent collections and active `funded`/`repaying` rent plans for expected/pending figures, preserving partial-payment shortfalls.
- Reuse current advance, service-centre, product, receivable, repayment and leaderboard definitions instead of inventing values.
- Aggregate names, relationships and financial values server-side to prevent N+1 queries and client-side reconciliation drift.
- Show an explicit unavailable/zero state when a source has no qualifying rows; never fabricate numbers.

## Export
- Reuse the existing branded Agent Operations report styling, typography, tables, chart treatment, header/footer and pagination.
- Export the same selected period and same report payload shown on screen, so HTML and exported output reconcile exactly.

## Validation
- Confirm preset/custom ranges use Kampala calendar boundaries.
- Reconcile section totals against their detail rows and confirm no duplicates from multi-agent service-centre assignments.
- Verify responsive tables/charts and print layout.
- Run focused type checks, build validation, and an authenticated report smoke test where access is available.

## Scope boundaries
- No changes to rent collection, advance, service-centre, product, leaderboard, wallet or ledger mutation logic.
- No synthetic data and no per-row data fetching.
