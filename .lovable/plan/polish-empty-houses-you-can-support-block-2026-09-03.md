# Polish: "Empty houses you can support" block

Scope: the empty-house section inside the Support Tenants Directly view of the Funder dashboard (`FunderCapitalOpportunities.tsx`). Visual polish plus small logic corrections. The fee slider stays exactly as it is.

## Visual polish

- Raise the type floor: replace the 9-10px labels with 10-11px minimums so figures and captions are readable on a phone; keep the same hierarchy (uppercase micro-label above a bold value).
- Rework the headline card into a clean two-value header: houses needing funding and total rent needed, with the accent gradient kept but softer, and consistent card radii/padding with the rest of the section.
- Tighten the "Biggest opportunities" list: aligned bars, consistent row height, clearer district/landlord toggle and Rank by / Show pill groups, and better spacing so the controls do not wrap awkwardly on mobile.
- Make the segmented toggles look like one control set (equal heights, shared border treatment) instead of three different sizes.
- Give the calculator panel and the CTA the same card language as the rest of Tenant/Funder cards; the "Browse empty houses" button becomes the clear primary action of the block.
- Verify at 393px, tablet and desktop widths.

## Logic polish

- Remove the duplicated "Still open" figure so the count appears once.
- Make the progress bar real: use `funded_count` / `house_count` from the summary instead of the hardcoded `0%`, and label it as funded vs still open. If the summary has no funded data, hide the bar rather than showing an empty one.
- Fix the heading typo "Ready to fun Rentals" to "Ready to fund rentals".
- Collapse the A/B calculator into a single scenario: one amount-or-houses input, one result (houses covered, funding, monthly return net of the configured fee). The comparison strip and the second scenario state are removed. `computeScenario` keeps its current maths unchanged.
- Guard the average-rent estimate so a zero/absent `avg_monthly_rent` shows the calculator as unavailable rather than dividing into nonsense house counts.

## Untouched

- Data source and hook (`useCapitalOpportunities`), the 15% return rate, the fee rate constant and its slider, PDF export behaviour, and the `EmptyHouseOpportunitiesSheet` picker flow.

## Technical notes

- All edits are in `src/components/supporter/FunderCapitalOpportunities.tsx`; state `calcHouses2` / `calcAmountInput2` and the `calc2` memo are deleted along with the comparison UI.
- Styling uses existing semantic tokens (`primary`, `success`, `muted-foreground`, `card`, `border`) — no new colours or design system.
