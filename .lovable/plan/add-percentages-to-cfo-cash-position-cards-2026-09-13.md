# Add percentages to CFO cash-position cards

## Goal
Show a clear percentage on each existing cash-position card, calculated against **Money We Have**.

## Changes
- Keep all current UGX amounts, calculations, data sources, dialogs, and click behavior unchanged.
- Add the percentage beside or directly below the main amount on these cards:
  - **Money We Have:** 100%
  - **Money We Owe:** Money We Owe ÷ Money We Have
  - **Money We Can Use:** Money We Can Use ÷ Money We Have
  - **Money in Treasury / Platform:** actual cash outside the bank ÷ Money We Have
  - **Money in Bank:** actual verified banked cash ÷ Money We Have
- Use a consistent compact label such as “8.3% of Money We Have.”
- Handle loading and a zero Money We Have balance safely, without showing `NaN` or infinity.
- Preserve the current card dimensions and visual hierarchy so the section remains balanced.

## Technical details
- Make this a presentation-only calculation in `CFOOverviewDashboard.tsx`; no database, ledger, wallet, RPC, or financial-source changes.
- Extend the local `HeroCard` interface with an optional percentage label and render it consistently on the card and its detail dialog.
- Add the same percentage treatment to the custom Money We Have card, which does not currently use `HeroCard`.
- Verify the dashboard build and inspect the selected CFO section at desktop and mobile widths.
