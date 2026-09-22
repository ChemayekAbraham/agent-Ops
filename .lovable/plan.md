# Tenant Operations Workspace responsive pass

## Scope
Update only the five approved Tenant Operations Workspace files. Preserve all calculations, data access, permissions, actions, exports, navigation, colors, and existing behavior.

## Changes
- Make both tab bars wrap cleanly using the established Tenant Ops Classic pattern.
- Improve KPI grids, headers, filters, pagination, action groups, and long-text handling across phone, tablet, laptop, and desktop widths.
- Reduce the Top-Up table to essential columns on phones, progressively reveal all existing columns at larger breakpoints, and keep every field available at desktop widths.
- Make contact forms, export controls, filter chips, dialogs, rule rows, switches, and dialog footers fit narrow and short screens.
- Keep existing mobile-card/table structural swaps and chart conventions; only adjust responsive wrappers and dimensions where needed.

## Validation
- Inspect the live workspace before and after changes at 1920×1080, 1440×900, 1024×768, 768×1024, 600×960, 390×844, 375×667, 320px wide, and 740×360.
- Exercise all four tabs, nested tabs, filters/chips, tables/cards, exports, empty/loading presentation, long names/large amounts, and both dialogs.
- Check for page-level horizontal scrolling, clipping, overlap, unreadable chart labels, and unreachable dialog actions.
- Run the project type check/guards and review the final diff to confirm five-file isolation.

## Technical notes
- Use Tailwind responsive variants only; do not edit shared table/KPI components.
- Use `lg` as the structural table/card cutover and existing semantic design tokens unchanged.
