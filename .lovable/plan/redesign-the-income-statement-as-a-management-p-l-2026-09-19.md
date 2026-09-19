# Redesign the Income Statement as a Management P&L

## Verified baseline
- Preserve the current production-backed calculations and registered account/category labels; this is a reporting-only change.
- The current displayed statement reconciles arithmetically: Net Revenue UGX 24,937,912 less Cost of Revenue UGX 1,193,370,798 equals Gross Loss UGX 1,168,432,886; after Operating Expenses, existing adjustments, depreciation, finance costs, and tax, the displayed Net Profit is UGX 45,249,635,146.
- Treat the existing Income Statement calculations as authoritative. Do not change transactions, mappings, classifications, account names, or ledger logic.

## What will change
- Replace the stacked single-period layout with a compact management P&L table showing **Current Period | Previous Period | Change | Change %**.
- Use the immediately preceding equivalent date range as the previous period, while keeping the existing period selector.
- Present the statement in this order: **Revenue → Cost of Revenue → Gross Profit → Operating Expenses → Operating Profit / (Loss) → Other Income / (Expense) → Profit Before Tax → Tax → Net Profit / (Loss)**.
- Keep every registered revenue and expense account name visible as a detail row under its existing report section.
- Group operating expenses visually for readability without moving an account to a different accounting classification.
- Keep existing adjustments visible inside operating results so the report still reproduces the current production total; do not conceal or reclassify them.
- Highlight Gross Profit, Gross Margin %, Operating Profit / (Loss), and Net Profit / (Loss) with restrained executive-report emphasis.
- Keep the supporting revenue-recognition schedule below the P&L, separate from reported revenue.

## Comparison and exports
- Calculate every comparison column from the same existing statement generator for the current and immediately preceding equivalent periods.
- Display a dash when percentage change is not meaningful because the previous value is zero.
- Update CSV and PDF exports to match the same row order, account labels, and four comparison columns.

## Verification
- Confirm every current-period subtotal and final result exactly matches the production-backed statement before the redesign.
- Confirm each previous-period value comes from the same accounting calculation over the equivalent prior date range.
- Verify Current minus Previous equals Change, and Change divided by the absolute Previous amount equals Change %.
- Run the financial safeguards and type checks, then verify the table at desktop and mobile widths without changing database or security configuration.
