# Reuse the current Supporter house map

## Goal
Replace the map inside `/dashboard/funder-new` with the same interactive empty-house map already used by `/dashboard/funder`.

## Changes
- Reuse `EmptyHouseMapBrowser` inside the selected location section instead of the route-specific basic marker map.
- Keep the new page’s section heading and live market summary, while using the existing map’s search, clustering, density view, location choice, full-screen mode, loading, and failure states.
- Connect marker taps to the existing house details view and mirror the new page’s empty-house search, location, amount filters, and selected-house state.
- Keep `/dashboard/funder`, all backend services, and all funding behavior unchanged.

## Verification
- Check marker details, map search, clusters, density view, location choice, and full-screen mode.
- Check mobile and desktop layouts, type checks, safeguards, and preview health.
