# Move Agent Float to Operational Float

## Outcome
- Remove **Agent Float — Amounts with Agents** from the Assets section.
- Show that same ledger-backed amount as **Operational Float** under **Market Place Liabilities**.
- Preserve its account details in the Operational Float modal and in CSV/PDF exports.

## Implementation
- Reclassify the existing A2 statement line at the presentation layer; do not change wallet, ledger, payment, or transaction records.
- Remove the empty Operational Float placeholder by assigning A2 to it exactly once.
- Recalculate displayed Assets, Market Place Liabilities, Total Liabilities, and Total Liabilities and Shareholders’ Equity from the reclassified rows.
- Keep the balance check transparent: no balancing plug or invented counterpart will be added. If this accounting reclassification makes the statement unequal, the existing warning will show the resulting difference.

## Verification
- Run the project’s financial safety guards and TypeScript check.
- Verify in the live preview that A2 is absent from Assets, appears once as Operational Float, opens with its source details, and exports consistently.
