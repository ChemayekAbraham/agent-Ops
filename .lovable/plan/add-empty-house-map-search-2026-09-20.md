# Add empty-house map search

## Goal
Add a fast search field to the existing empty-house map so Supporters can find houses by district, neighborhood, or house name.

## Changes
- Add a search box over the map with a clear action and accessible label.
- Reuse the existing house list locally; match house title, district, village, and sub-county without changing backend queries.
- Apply the same search result set to map markers and house cards, reset pagination when the search changes, and show a clear no-results state.
- Preserve all existing sorting, filters, saved-house selection, details, and funding actions.

## Verification
- Check search matches district, neighborhood, and house name.
- Check clearing search restores all houses.
- Verify mobile and desktop layouts, keyboard access, type checks, guards, and preview build health.

## Technical details
The search remains presentation-only and filters the already-loaded verified empty-house records. No database, ledger, wallet, or funding logic changes.
