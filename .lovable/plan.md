# Restore the original Calling Hub on Tenant and Landlord dashboards

## What went wrong

Earlier today the Tenant Ops and Landlord Ops dashboards were switched from their own Calling Hub screens to a new shared call-centre hub. That replaced the whole page instead of just adding person details, which is what was asked for.

The two shell files are the only place that swap happened (a single import + a single line each). The original hubs, their tables, drawers and hooks are all still in the codebase and untouched by that swap.

## The revert

- Tenant Ops dashboard: point the "Calling Hub" view back at the original tenant Calling Hub.
- Landlord Ops dashboard: point the "Calling Hub" view back at the original landlord Calling Hub.

Nothing else changes: the new shared call-centre hub stays in the codebase (it is still used by the Agent Ops dashboard) but is no longer mounted on these two dashboards. Layout, tabs, counters, exports and calling actions on both pages return exactly to yesterday's behaviour.

## What stays (already in place, matching the request)

Two earlier changes from today are kept because they are what was actually asked for:

- **Person details when opened.** The tenant and landlord call drawers already surface the stored details next to the calling interface — full name, phone, email, national ID, assigned agent, landlord/tenant links, location (district, sub-county, parish, village, landmark), mobile money name/number, occupation, language, status and registration history. All read from existing fields; no new tables, no logic changes.
- **"To call" population.** The tenant list no longer reads the daily-eligibility view (which only returns money-due / defaulting rows). It reads active rent plans (`funded`, `repaying`) directly, and the "To call" tab now includes every tenant who has never been called or whose call state does not place them in Pending, Closed or Missed. Payment, missed-days and status logic are unchanged.

After the revert I will open both dashboards in the preview to confirm the pages look like the originals and that the drawer details still render.

## Technical detail

Revert commit `195a2d66` in these two files only:

- `src/components/executive/tenant-ops/TenantOpsClassicShell.tsx` — restore `TenantCallingHub` for `active === 'calling-hub'`.
- `src/components/executive/landlord-ops/LandlordOpsClassicShell.tsx` — restore `LandlordCallingHub` for `active === 'calling-hub'`.

No database, RPC, RLS or hook changes.
