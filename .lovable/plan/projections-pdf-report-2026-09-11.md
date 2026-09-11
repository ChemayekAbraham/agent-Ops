# Projections PDF report

Add an "Export PDF" button next to the existing CSV export on the Projections tab (Tenant Ops → Classic → Workspaces → Tenant Products & Services). The PDF reflects exactly the filters on screen — location drill-down, agent, landlord, house, unmapped, search and the Month / Quarter / Year view.

## What the PDF contains

1. **Cover header** — Welile branding, report title, the time view (month/quarter/year), the 12-month window, generation timestamp in Kampala time, and a plain-language line listing every active filter (or "Whole portfolio" when none).
2. **Headline figures** — plans, tenants, landlords, houses, agents, unmapped plans, monthly tenant rent, monthly landlord cost, monthly margin, and the 12-month totals, laid out as a clean figure grid.
3. **Period table** — one row per month (or quarter/year, following the selected view) with tenant rent, landlord cost, margin and margin percentage, plus a totals row.
4. **Breakdown table** — the same grouped breakdown shown on screen (by location level / agent / landlord), sorted by monthly tenant rent, with each group's share of the total.
5. **Plan detail table** — every plan matching the filters (not just the visible page), with tenant, phone, house, location, agent, landlord, status, cycle end, monthly rent, monthly landlord cost, monthly margin and 12-month rent. Capped at 2,000 plans; if the filter matches more, the PDF says so and points to the CSV export.
6. **Footer on every page** — page numbers, filter summary, and a note that figures are read-only projections from recorded active plans.

## Notes

- Read-only: nothing is written, and no figure is recalculated in the browser beyond simple totals of values the server already returned.
- Unmapped plans stay labelled "Unmapped" with their original location text preserved.

## Technical

- New `src/lib/tpspProjectionPdf.ts` built with the same lazily-imported `jspdf` + `jspdf-autotable` pattern and visual language as `src/lib/tppoPlanDetailPdf.ts` (landscape A4, pt units, striped tables, muted rules, `formatUGX`).
- Data comes from the existing RPCs via `useTpspProjection` / `useTpspProjectionFilters` and a one-off `tpsp_projection_rows` call with `p_limit: 2000, p_offset: 0` and the current filter arguments. No new RPCs, no schema changes.
- `TenantProductsProjections.tsx` gains an `Export PDF` button with its own loading state; the existing CSV export, filters, charts and pagination stay unchanged.
- Typed against the existing `TpspProjection` / `TpspDetailRow` / `TpspFilterOptions` interfaces so no field is invented.
- Verify with a typecheck, `npm run guard:all`, and a build; QA the generated PDF page-by-page as images before finishing.
