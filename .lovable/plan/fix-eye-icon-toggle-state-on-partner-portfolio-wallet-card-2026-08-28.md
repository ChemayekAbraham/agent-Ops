# Fix eye-icon toggle state on partner portfolio wallet card

## Problem
In `PartnerPortfolioWalletCard.tsx` the visibility icon is inverted:
- Amount hidden (`showAmount === false`) currently renders the open `Eye` icon.
- Amount revealed (`showAmount === true`) currently renders the crossed `EyeOff` icon.

This is the opposite of the expected convention: a crossed/closed eye should indicate "hidden", and an open eye should indicate "visible".

## Changes
1. Swap the icon mapping in the toggle button so:
   - `showAmount === false` → render `EyeOff` (hidden).
   - `showAmount === true`  → render `Eye` (visible).
2. Remove the 2-second auto-hide `useEffect` and its `hideTimeoutRef`. The auto-hide timer compounds the confusion by flipping the amount back to hidden shortly after the user reveals it, making the toggle feel unresponsive or "vice versa".

## Files to edit
- `src/components/supporter/portfolio/PartnerPortfolioWalletCard.tsx`

## Verification
- Open `/dashboard/funder` (or any route that renders `PartnerPortfolioWalletCard`).
- Confirm the card initially shows a crossed `EyeOff` icon while the amount is masked as `UGX ••••••`.
- Click the icon: it should switch to the open `Eye` icon and reveal the formatted amount.
- Click again: it should switch back to the crossed `EyeOff` icon and mask the amount.
- Confirm the revealed amount does not auto-hide after 2 seconds.
