# Reposition Wallet Illustration on Hero Card

## Goal
Replace the existing wallet-rafiki illustration with the newly uploaded `Wallet-rafiki-2.svg`, remove it from inside the withdrawable-balance button, and reposition it so it grazes the top-left border of the entire `UnifiedWalletHeroCard`.

## Current State
- `src/components/wallet/UnifiedWalletHeroCard.tsx` renders the current SVG (`wallet-rafiki.svg.asset.json`) in two places:
  1. Inside the agent split view’s **Withdrawable** cell (lines ~285–289).
  2. Inside the default single-balance button (lines ~321–324).
- Both placements use absolute positioning inside a `relative` wrapper (`-top-5 -left-5` / `-top-6 -left-6`) within the balance div, so the illustration sits over the balance text.
- The card root is a `motion.div` with `relative overflow-hidden rounded-3xl` (line ~172).

## Proposed Change
1. **Upload the new asset**
   - Use the Lovable Assets CLI to upload `/mnt/user-uploads/Wallet-rafiki-2.svg` and create `src/assets/wallet-rafiki-2.svg.asset.json`.

2. **Remove inline SVGs from balance divs**
   - Delete the `<img>` block inside the agent split **Withdrawable** section.
   - Delete the `<img>` block inside the default single-balance button.
   - Remove the now-unused import of `walletRafikiAsset`.

3. **Add the illustration at the card top-left border**
   - Import the new asset pointer (`walletRafiki2Asset`).
   - Place a single decorative `<img>` as the first child of the card root `motion.div` (before the background decorative layers).
   - Position it absolutely with negative offsets so it bleeds slightly over the card’s top-left corner, e.g.:
     - `className="absolute -top-4 -left-4 w-24 h-auto pointer-events-none opacity-90 z-0"`
   - Keep `pointer-events-none` and a low z-index so it never blocks taps on the collapse button, balance, or "View Wallet".
   - Use `aria-hidden` and an empty `alt` because it is purely decorative.

4. **Responsive sizing**
   - Use a width that scales with the card (e.g. `w-20 sm:w-24`) so it remains subtle on small screens and clearly visible on larger ones.

5. **Clean-up**
   - Verify no other component imports the old `wallet-rafiki.svg.asset.json`; if it is now unused, delete the old pointer file.

## Verification
- Open the preview on a funder/agent/tenant dashboard that uses `UnifiedWalletHeroCard`.
- Confirm the illustration no longer overlaps the balance text.
- Confirm it sits at the top-left corner of the card and visually grazes the border.
- Tap the balance, collapse button, and "View Wallet" to ensure the illustration does not intercept pointer events.

## Files to Modify
- `src/components/wallet/UnifiedWalletHeroCard.tsx`
- `src/assets/wallet-rafiki-2.svg.asset.json` (new)
- `src/assets/wallet-rafiki.svg.asset.json` (delete if unused)
