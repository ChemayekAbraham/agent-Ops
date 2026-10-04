# Polish the Tenant Products & Services Modal

## Goal
Restyle the existing "Tenant Products & Services" modal in the CFO Dashboard so it looks more professional, clean, and polished while keeping every behavior, data source, and interaction exactly as it is today.

## Scope
- File: `src/components/cfo/ReceivablesBreakdownForecast.tsx` (modal shell and trigger)
- File: `src/components/cfo/TenantPaymentsLocationFilters.tsx` (payment activity / receipts)
- File: `src/components/executive/tenant-ops/CollectionsProjectionPanel.tsx` (forecast chart/table)

No logic, data fetching, state, RPC calls, PDF export, or accounting behavior will change. This is a purely presentational pass.

## What Will Change

### 1. Modal Chrome
- Add a clear header with title, subtitle, and well-aligned close control.
- Increase and unify internal padding (`p-6` or `sm:p-8`) with consistent section gutters.
- Use a subtle but defined shadow/border that matches the CFO Dashboard card style.
- Keep the large responsive width (`max-w-7xl`, `95vw`) and scrollable body.

### 2. Section Hierarchy
- Wrap the three internal areas in visually distinct cards:
  1. **Product Summary** — Rent Access Plans line with item count and share.
  2. **Payment Activity by Location** — filters, summary stats, drill-down rows, receipts.
  3. **Collections Forecast** — KPIs, chart, period table, methodology disclosure.
- Use section titles, icons, and separators so each area is easy to scan.

### 3. Filters & Inputs
- Lay out the date + method filters and the five cascading location selects on a tidy grid with aligned labels and consistent control heights.
- Improve disabled-state affordances and placeholder text.
- Make the "Reset" action more visible but unobtrusive.

### 4. Summary Stat Cards
- Style Collected / Payments / Tenants paying / Not placed as a uniform KPI row with clear labels and monospace figures.
- Apply the same treatment to the Collections Forecast KPIs (Expected collections / Likely range / Daily level / Confidence).

### 5. Drill-Down and Receipt Lists
- Standardize row padding, hover state, and border treatment.
- Use badges for payment method and location where helpful.
- Improve empty/loading/error states with centered, legible messaging.

### 6. Chart & Table
- Give the chart container consistent padding and border.
- Polish the forecast table: cleaner headers, cell alignment, alternating hover, and badge colors tied to semantic tokens.
- Make the "How this is calculated" disclosure neater without hiding its content.

### 7. Typography & Spacing
- Adopt a stricter type scale: section labels uppercase/tracking-wide at a consistent size, values slightly larger and tabular, captions muted.
- Remove cramped margins; use `space-y` and card padding to group related content.
- Ensure all colors come from existing semantic tokens (`bg-card`, `text-muted-foreground`, `border-border`, `primary`, `success`, `warning`, `destructive`) — no hardcoded hex values.

## Out of Scope
- No changes to data sources, hooks, RPCs, or calculations.
- No new features, buttons, or navigation.
- No changes to PDF generation, export logic, or the underlying forecast model.
- No modifications to non-Tenant-Products categories or the CFO Dashboard outside this modal.

## Success Criteria
- The modal opens from the same trigger and displays the same content.
- All existing filters, drill-downs, receipts, chart interactions, and PDF export continue to work.
- TypeScript check and production build remain clean.
- The modal is visually consistent with the CFO Dashboard and easier to scan.

## Notes
This is a UI-only styling task. Per the project's division of labor, the visual implementation should be handled by the UI agent to avoid conflicting with the design system ownership.