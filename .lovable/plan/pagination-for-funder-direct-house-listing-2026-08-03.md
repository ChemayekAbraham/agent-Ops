# Pagination for Funder Direct House Listing

## What to build
Add page-based pagination to the house-card grid in `FunderDirectHouseListing.tsx` so only 4 cards display at a time, with controls to move between pages.

## Changes
1. State
   - Add `page` state, reset to 1 whenever search/filters/sort change.
   - Set page size constant `CARDS_PER_PAGE = 4`.
2. Derived data
   - Compute `paginatedHouses` from `filtered` using `page` and `CARDS_PER_PAGE`.
   - Compute `totalPages = Math.ceil(filtered.length / CARDS_PER_PAGE)`.
3. UI
   - Render `paginatedHouses` instead of the full `filtered` array in the grid.
   - Replace the existing "Showing X of Y" text with "Showing X–Y of Z".
   - Add a pagination control bar below the grid:
     - Previous / Next buttons.
     - Clickable page numbers (compact: first, current neighbourhood, last).
     - Disabled states on first/last page.
4. UX
   - Scroll the listing container to top smoothly on page change.
   - Keep selected house IDs and the floating selection summary intact across pages.
   - Preserve the existing "Load more houses" button behaviour; pagination slices what has already been loaded.

## Files touched
- `src/components/supporter/FunderDirectHouseListing.tsx`

## No new dependencies
Uses existing `lucide-react` icons and Tailwind classes already present in the file.
