# Landlord Ops dashboard polish

## Goal
Make the Landlord Float register easy to reach from the Landlord Ops home page, and bring the Landlord Ops wordmark in line with the Welile brand.

## Changes

### 1. Prominent "Landlord Float" button at the top of the dashboard
- Add a full-width action card at the top of `src/components/executive/landlord-ops/LandlordOpsTodayView.tsx`, above the existing grid.
- Card label: **Landlord Float**.
- Icon: `Wallet` or `Landmark` (matching the existing Registers → Landlord Float sidebar item).
- Action: navigate to `/landlord-ops/registers/landlord-float`.
- Optional: show the current float total from `useLandlordFloatOverview()` if the hook is already available; otherwise keep it a simple link card to avoid extra backend work.
- Style it with the same card/padding/shadow patterns already used by the four workspace cards, but make it visually distinct as the primary entry point.

### 2. Replace the hardcoded wordmark with the brand logo
- In `src/components/executive/landlord-ops/LandlordOpsTopBar.tsx`, replace the two hardcoded green **"WELILE"** `<span>` blocks (desktop header and mobile sheet header) with the existing `WelileLogo` component.
- Keep the **"Landlord Operations"** label next to the logo.
- Use the `sm` size and default variant so the height matches the current top bar.
- Remove the manual `#0FA958` colour utilities and rely on the logo component’s theme-aware styling.

## Out of scope
- No changes to the sidebar route or the `registers/landlord-float` page itself.
- No changes to calculations, backend RPCs, or permissions.
- No changes to other dashboards.

## Acceptance
- Landlord Ops Today dashboard shows a clear "Landlord Float" card/button at the top.
- Clicking it navigates to `/landlord-ops/registers/landlord-float`.
- Top-left header shows the Welile logo mark + "Welile" wordmark instead of plain "WELILE" text.
- Build passes without type errors.
