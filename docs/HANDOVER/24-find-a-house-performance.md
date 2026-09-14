# FindAHouse Page Performance — Handover to Claude

## Problem

The `/houses` (FindAHouse) page loads slowly — **3–9 seconds** before any listing renders on mobile. The root cause is the data-fetching strategy in [`useNearbyHouses`](file:///Users/macbookair/Public/welilereceipts-com-98bba33b/src/hooks/useHouseListings.ts#L372) and how [`FindAHouse.tsx`](file:///Users/macbookair/Public/welilereceipts-com-98bba33b/src/pages/FindAHouse.tsx#L477-L506) calls it.

## Loading Waterfall

```
Browser GPS prompt ────────────────→ 1–5s on mobile (blocks everything)
  └─→ house_listings query (500 rows, 50 cols each) ──→ 1–3s network + DB
       └─→ enrichWithAgentInfo RPC (waterfall) ────────→ 0.5–1s extra round-trip
  └─→ useHouseListingCount (parallel count query) ────→ 0.5–1s
```

**Total: 3–9 seconds** before a single card appears.

## Root Causes (all in Claude's domain)

### 1. `pageSize: 500` on first load
[`FindAHouse.tsx:504`](file:///Users/macbookair/Public/welilereceipts-com-98bba33b/src/pages/FindAHouse.tsx#L504) — The first page fetches **500 rows** so the map view and location dropdowns see all results immediately. But the list view (default) only needs ~12–24 to fill the viewport.

### 2. Photo filter is client-side, not DB-side
[`useHouseListings.ts:514`](file:///Users/macbookair/Public/welilereceipts-com-98bba33b/src/hooks/useHouseListings.ts#L514) — After fetching 500 rows, `listingHasRealPhoto()` filters out rows with no photos. Those rows were fetched, transferred, and parsed for nothing.

### 3. Agent enrichment is a waterfall RPC
[`useHouseListings.ts:515`](file:///Users/macbookair/Public/welilereceipts-com-98bba33b/src/hooks/useHouseListings.ts#L515) — After the listing query completes, a **second** RPC (`get_listing_agent_contacts`) fires with all listing IDs. Sequential waterfall.

### 4. GPS blocks the entire fetch
[`FindAHouse.tsx:505`](file:///Users/macbookair/Public/welilereceipts-com-98bba33b/src/pages/FindAHouse.tsx#L505) — `enabled: hasSharedLocation || !geo.loading` means the query won't fire until the browser resolves GPS.

### 5. SELECT columns are wide
[`houseListingColumns.ts`](file:///Users/macbookair/Public/welilereceipts-com-98bba33b/src/lib/houseListingColumns.ts) — The query selects **50 columns** per row. The Airbnb-style card only uses ~20.

## Recommended Fixes

| # | Fix | Time Saved | Effort |
|---|-----|-----------|--------|
| 1 | **`pageSize` 500 → 24** — let infinite scroll paginate; lazy-load pins-only query for map mode | **2–4s** | 1 line |
| 2 | **Photo filter to DB** — `.not('image_urls', 'is', null)` in query builder | **0.3–0.5s** | 2 lines |
| 3 | **Inline agent join** — DB view or materialized columns instead of waterfall RPC | **0.5–1s** | Medium |
| 4 | **Don't wait for GPS** — start fetch immediately, re-sort by distance when GPS arrives | **1–5s** | Low |
| 5 | **Narrow SELECT** — create `PUBLIC_HOUSE_CARD_COLUMNS` with only the ~20 used columns | **0.2–0.5s** | Low |
| 6 | **React Query cache** — `staleTime: 5min` so back-navigation doesn't re-fetch | Instant revisits | Medium |

## Files Involved

| File | What to change |
|------|---------------|
| [`useHouseListings.ts`](file:///Users/macbookair/Public/welilereceipts-com-98bba33b/src/hooks/useHouseListings.ts) | `enrichWithAgentInfo`, `fetchRaw`, photo filter, caching |
| [`FindAHouse.tsx`](file:///Users/macbookair/Public/welilereceipts-com-98bba33b/src/pages/FindAHouse.tsx#L477-L506) | `pageSize`, `enabled`, map-mode lazy query |
| [`houseListingColumns.ts`](file:///Users/macbookair/Public/welilereceipts-com-98bba33b/src/lib/houseListingColumns.ts) | Narrow column set |
| DB migration (new) | `has_photos` generated column, agent view/join |
