TPPO-A-P10 Cleanup Plan

Scope: Two files only, no migration, no App.tsx or sidebar changes.

1. `src/pages/tenant-ops/PortfolioPerformanceReport.tsx`
   - Remove any `ZONE_PLACEHOLDERS` declaration and its `.map(...)` render block if present; if absent, confirm it is already gone.
   - Extend `ZoneAReport` interface with exactly these nullable fields returned by `tppo_get_report_zone_a`:
     - `rate_variance_pp: number | null`
     - `collected_delta_ugx: number | null`
     - `scheduled_delta_ugx: number | null`
     - `prior: { period_start: string | null; period_end: string | null; collected_ugx: number | null; scheduled_due_ugx: number | null; collection_rate_pct: number | null } | null`
   - Export `ZoneAReport` so `VarianceA2.tsx` can import it.
   - Do not alter the RPC call, query key, toggle order, or render order of HeadlineA1 / VarianceA2 / ProjectionA3.

2. `src/components/tenant-ops/tppo/VarianceA2.tsx`
   - Import `ZoneAReport` from `src/pages/tenant-ops/PortfolioPerformanceReport.tsx`.
   - Replace `VarianceA2Report` usage with `ZoneAReport`.
   - Delete the local `VarianceA2Report` interface declaration so the RPC payload has one type source only.

3. Validation
   - Run `tsgo --noEmit` or `bunx tsc --noEmit` to confirm type-check passes.
   - Confirm via `rg ZONE_PLACEHOLDERS` that the string no longer exists in the repo.
   - Report files modified, lines added/removed per file, commit SHA, and type-check result.
