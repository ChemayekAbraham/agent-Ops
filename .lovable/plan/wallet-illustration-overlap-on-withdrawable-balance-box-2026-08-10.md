# Wallet Illustration Overlap on Withdrawable Balance Box

Add the uploaded `Wallet-rafiki.svg` illustration to the wallet hero card so it overlaps the top-left corner of the inner "Withdrawable Balance" box across all four dashboards (Tenant, Agent, Funder/Partner, Owner).

## What the user sees

The `Wallet-rafiki.svg` illustration sits partially outside the top-left border of the withdrawable balance box, creating a layered, card-with-sticker effect. It is decorative only — no wallet numbers, hooks, or interactions change.

## Implementation

1. **Asset ingestion**
   - Register `Wallet-rafiki.svg` as a Lovable Asset pointer at `src/assets/wallet-rafiki.svg.asset.json` using the sandbox CLI.
   - Import the pointer into `UnifiedWalletHeroCard.tsx`.

2. **Component placement**
   - Wrap the existing withdrawable balance `<button>` (and the agent split withdrawable cell) in a relative container.
   - Insert the SVG as an absolutely positioned element at the top-left of that container, using negative offsets (e.g. `-top-6 -left-6` or responsive equivalents) so it bleeds over the rounded border.
   - Set `pointer-events-none` so it does not block taps on the balance box.
   - Constrain the SVG width to a sensible max (e.g. `w-24` / `w-28`) and preserve aspect ratio.

3. **Visual blending**
   - Apply a subtle opacity token (e.g. `opacity-90`) so the illustration does not fight with the balance text.
   - Ensure `z-index` places the SVG above the box border but below any dropdowns/modals.
   - Use `primary-foreground` compatible tones; do not hardcode hex colors.

4. **Responsive check**
   - On very small screens, reduce the SVG size so the overlap does not push the card width or hide the balance amount.

## Out of scope

No changes to wallet balances, ledger reads, hooks, RPCs, deposit/withdraw/transfer flows, or the bottom navigation.
