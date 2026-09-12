# Tenant Payments Filter Label — Show Active Filter by Name

## Goal
Make the receipt-list header under Tenant Products & Services state the currently active filter context by name, instead of the generic “Payments matching your filters.”

## Scope
- File: `src/components/cfo/TenantPaymentsLocationFilters.tsx`
- Change the `<h4>` that introduces the paged receipts list.
- Keep all existing behavior: cascading location drill-down, method filter, date filters, pagination, receipts, and badges.

## What Will Change

### 1. Dynamic header text
Derive the most specific active filter and render it in the heading:

```text
No location selected  -> "All filtered payments"
Country selected      -> "Payments — Uganda"
Region selected       -> "Payments — Central Region"
District selected     -> "Payments — Wakiso District"
Sub-county selected -> "Payments — Kira Town Council"
Village selected      -> "Payments — Kira Village"
```

The existing village branch (`sel.village ? 'Payments — ${sel.village}' : …`) is generalized to fall back through `subcountyLabel`, `districtLabel`, `region`, and `country`, ending with a generic fallback.

### 2. Method/date context (optional, unobtrusive)
Add a muted subtitle line directly below the heading showing the active method and date range only when they differ from defaults, e.g.:

```text
Mobile money · 01 Aug 2026 – 12 Sep 2026
```

If method is “All methods” and dates are the default 30-day window, the subtitle is omitted to avoid noise.

### 3. Keep badges
The existing total-amount and tenant-count `Badge` components remain next to the heading.

## Out of Scope
- No changes to data fetching, RPCs, hooks, calculations, pagination, or PDF export.
- No changes to other CFO Dashboard sections.
- No changes to location hierarchy or approved IDs.

## Success Criteria
- The header names the most specific selected location level.
- Method and date context appear as a subtle subtitle only when useful.
- Existing filters, drill-downs, receipts, and pagination continue to work.
- TypeScript check and production build remain clean.
