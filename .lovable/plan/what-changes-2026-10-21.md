Add Project Progress and Key Metrics Overview to the R&D General report

## What changes
At the top of the General report PDF, before the Business Ideas cash table, add two short sections that match the R&D page:

1. **Project Progress**: one row per project with its stage and progress percentage (Welile Car 65%, Welile Dowry 40%, Welile School of AI 25%), plus a simple filled bar.
2. **Key Metrics Overview**: Total customers (across projects), Total cash in, and Net position (cash in minus cash out). Figures come from the same cash table the page uses, so the PDF and the page always agree.

Nothing else in the report changes. Recorded updates, the cash table and saved ideas stay as they are. All amounts show as UGX.

## Technical details
- `src/lib/rdGeneralReportPdf.ts`: add an optional `progress: { name; stage; percent }[]` field to `RdReportData`. Render a progress table with bars drawn in the percent column, then a three-column metrics table built from the existing `rdCashTotals(d.ideas)`.
- `src/pages/rd/Dashboard.tsx`: pass `progress` from the existing `PROJECTS` list when calling `downloadRdGeneralReport`.
- Add a small test that the metrics come from `rdCashTotals` (for example 70 customers, UGX 21,670,000 in and UGX -23,877,000 net for matching rows).
