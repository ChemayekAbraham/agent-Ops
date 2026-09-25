# Match rent-plan cards to empty-house cards

## Outcome
Rent plans will use the same image-first listing-card layout as the Empty houses tab, while keeping all current rent-plan data and funding behavior.

## Changes
- Restyle each rent-plan card to match the existing empty-house card: identical image ratio, border, spacing, title treatment, amount hierarchy, monthly Returns line, and bottom action row.
- Keep the Rent plan badge and existing multiple-photo indicator on the image.
- Replace the compact selection circle with the same full-width “Fund this House” action used by empty-house cards; selected plans continue to show “Selected.”
- Keep the existing detail view, share action, funded/on-hold states, affordability check, top-up prompt, and funding calculations unchanged.
- Keep the current responsive grid so cards align consistently across phone and desktop widths.

## Technical notes
- Edit only the rent-plan presentation in `src/components/partner/SelfPortfolioFundingCard.tsx`.
- Reuse existing semantic design tokens and shared buttons; no database, wallet, or funding-flow changes.
- Verify the preview at desktop and mobile widths, then check the current build status.
