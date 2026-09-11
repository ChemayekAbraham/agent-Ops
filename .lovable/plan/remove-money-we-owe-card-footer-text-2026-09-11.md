# Remove Money We Owe card footer text

## Goal
Remove the descriptive footer line currently shown under the **Money We Owe** headline card on the CFO dashboard.

## Current state
- `src/components/cfo/CFOOverviewDashboard.tsx` line 399 passes this footer to the `HeroCard` for Money We Owe:
  `footer="Merchant float bucket (wallet books) plus the Bayo Mercy account (tap any figure for every movement behind it)"`
- `HeroCard` requires `footer: string` and always renders it at line 753.

## Changes
1. In `CFOOverviewDashboard.tsx`: remove the `footer` prop from the Money We Owe `HeroCard` call.
2. In `HeroCard`: make `footer` optional (`footer?: string`) and render the footer `<p>` only when a non-empty footer is provided.
3. Leave all other cards and their footers untouched.
4. Verify with typecheck and production build.
