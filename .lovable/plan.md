# PSO-HEAD-1 — Part 2: "My team" section for the PSO head

Part 1 is applied: active_leads = 1, patched_functions = 3.

## Files found
- My Space own-performance screen: `src/hr/pages/MyPerformance.tsx` (route `/me/performance`, opened from the My Space hub `src/pages/me/PersonalHub.tsx`). This is where a PSO sees their own figures today.
- HR dashboard PSO report: `src/hr/pages/PlatformSalesOfficers.tsx` (route `/hr/reports/platform-sales-officers`). It is a full page (default export) with its date-window controls, data calls and table all inside it — there is no separate reusable component or hook.

## What changes
1. `src/hr/pages/MyPerformance.tsx`
   - Call `pso_is_team_lead()` once (cached).
   - Only when it returns true, render a "My team — Platform Sales Officers" section below his own performance, showing the existing report embedded.
   - For anyone else nothing renders and nothing else on the screen changes.
2. `src/hr/pages/PlatformSalesOfficers.tsx` — optional props only, defaults keep the HR dashboard identical:
   - `embedded?: boolean` — leave out the page header/back link so it fits inside My Space.
   - `hideCommission?: boolean` — hide the commission_base / commission_accrued columns and the commission totals/funding-commission panel.
   - Same date-window controls and same data functions (`pso_promise_summary`, `pso_funded_summary`, `pso_daily_series` with `p_staff_id = null`, names via `pso_officer_names()`).
   - Still shown: notes, pending/approved, notes funded, funders converted, top-ups, amount deployed.

## Note on scope
The report's commission data comes partly from `funding_commission_summary`; with `hideCommission` that call is skipped so the head never loads commission figures. No other files are touched; the HR dashboard looks and works exactly as now.

## Check
Sign in as Jacob Munabi to confirm the section shows every PSO without commission columns, and as another PSO to confirm My Performance is unchanged.
