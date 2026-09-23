# Show nearby homes once a funder shares their location

Today, tapping "use my location" on the funder dashboard centres the map tightly on the funder. If the closest listed home is 100+ km away (which it is for this account), the map shows "No empty houses in this area yet" and the cards underneath stay in cheapest-rent order, so the nearest homes are buried pages down.

## What changes

**The map**
- After a location fix, the map keeps its close-in view when homes are nearby.
- When nothing is in view, it automatically widens to include the closest homes instead of showing an empty map, and says how far away they are (for example: "Closest homes are about 109 km away").
- The funder can still pan, zoom and pick an area manually exactly as now; the auto-widening happens once per location fix and never fights a manual move.

**The house cards below**
- Once location is shared, the list switches to nearest-first automatically and each card measures its distance from the funder's own position.
- If the funder picks a different order themselves, their choice wins and is never overridden.
- Tapping a home on the map still re-anchors distances to that home, as it does today.

## Technical notes

- `src/components/partner/EmptyHouseMapBrowser.tsx`: after a granted fix (initial locate, return-visit re-locate, and the Locate-me button), if `cellsQuery` reports `housesInView === 0`, run one read of `agent_list_empty_house_opportunities` with `p_near_lat` / `p_near_lng` / `p_sort: 'nearest'`, `p_gps_only: true`, small limit (about 10), then `fitBounds` over the funder position plus those homes (padded, capped max zoom). Guarded by a ref so it runs once per fix and is skipped after any user pan/zoom.
- Empty-state copy gains the nearest-distance sentence when the nearest lookup returned rows.
- `src/components/partner/SelfPortfolioFundingCard.tsx`: in the sort comparator, `distanceTo` falls back to `userPoint` when `referencePoint` is null (currently it only uses `referencePoint`, then `h.distance_km`); and once `userPoint` arrives, default `houseSort` flips from `rent_asc` to `nearest` unless the funder has already changed the sort (tracked with a `sortTouched` ref, same pattern as the funder-new route).
- Frontend only. No schema, RPC, ledger or wallet changes; no new tables or policies.
