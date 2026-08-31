# Tenant dashboard action cards: square grid layout and themed cards

## Goal
Convert the "Find a House Nearby" and "Request rent as tenant" cards on the tenant dashboard into two square cards that sit side-by-side, with bigger headings, very short descriptions, and distinct pastel themes (light green for rent request, light yellow for find a house).

## Implementation plan

1. **Layout wrapper in `TenantDashboard.tsx`**
   - Replace the vertical `space-y-3` container around `FindAHouseCTA` and `TenantRentRequestCard` with a 2-column grid: `grid grid-cols-2 gap-3`.
   - Keep the existing `WidgetErrorBoundary` wrappers.
   - Do not change the other dashboard sections (`SuggestedHousesCard`, wallet hero, etc.).

2. **Square card shape**
   - Apply `aspect-square` to both cards.
   - Use flex column layout with centered content and `justify-between` so text/icon/bottom action distribute evenly inside the square.
   - Add `min-h-0` and `overflow-hidden` safety classes so the square shape does not break on very small viewports.

3. **`FindAHouseCTA.tsx` — yellow theme + copy tightening**
   - Card styling: `bg-warning/10 border-warning/20` with `text-warning` accents.
   - Icon container: `bg-warning/20` with `text-warning`.
   - Heading: increase to `text-lg` and keep `font-bold`.
   - Description: shorten to one line, e.g. "Browse verified daily-rent houses".
   - Keep the live count badge but make it compact; retain the chevron at the bottom-right.

4. **`TenantRentRequestCard.tsx` — green theme + copy tightening**
   - Card styling: `bg-success/10 border-success/20` with `text-success` accents.
   - Icon container: `bg-success/20` with `text-success`.
   - Heading: increase to `text-lg` and keep `font-bold`.
   - Description: shorten to one line, e.g. "Request rent · agent verifies your house".
   - When an open request exists, show only the status badge and the amount on one line; move the longer status note into a tooltip or drop it to keep the card compact.
   - The existing dialog logic stays unchanged.

5. **Accessibility & touch**
   - Maintain `touch-manipulation` and visible focus rings.
   - Ensure text still passes contrast against the tinted backgrounds.

## Verification
- Run the production build and confirm no TypeScript/lint errors.
- Preview at 375px, 768px, and 1440px widths to confirm both cards remain square and side-by-side and no text overflows.
