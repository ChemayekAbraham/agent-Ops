# Landlord Ops: hub-based navigation matching Tenant Ops

Restructure how Landlord Ops presents its existing work — no logic, data, permission or workflow changes.

## What is wrong today

The Landlord Ops overview already routes most sections into dedicated views (`view` state + "Overview" back row), but the home page itself also stacks six full working panels on top of the navigation: agent landlord-verification requests, LC1 verification inbox, rent pipeline queue, rejected-requests queue, landlord payout review, agent rent capacity, plus a payout report date-picker/export toolbar. On a phone this makes the dashboard an extremely long scroll before a manager reaches the navigation cards. Existing hub views also use a lighter back row and a different card treatment than Tenant Ops.

## Target model

```text
Landlord Ops Dashboard (navigation + KPIs + verification card)
        v  tap a hub tile
Dedicated Hub (title, existing panel, Back to Overview)
        v  Back
Landlord Ops Dashboard
```

## Changes

1. **Shared hub primitives** — extract the Tenant Ops hub pattern into reusable components so both dashboards use one implementation:
   - `HubEntryCard` — the icon + title + description + stat pills + "Open hub" tile currently inlined as `renderHubEntry` in `TenantOpsDashboard`.
   - `HubHeader` — the sticky "Back to Overview · <Section>" row.
   Tenant Ops switches to these components with identical rendering; nothing else in Tenant Ops changes.

2. **Move the six inline panels into hubs** (per your choice: hub everything except the verification card). Each becomes a new `view` value rendering the exact same component, unchanged, inside a hub shell:
   - Agent Verification Requests
   - LC1 Verification Inbox
   - Rent Pipeline (landlord stage)
   - Rejected at Landlord Ops
   - Landlord Payout Review
   - Agent Rent Capacity
   On the overview each is represented by a `HubEntryCard` carrying its live pending count, so nothing becomes invisible.

3. **Reports & Exports hub** — move the landlord payout report date pickers and every export button (payout report, landlord report, funded report, house report, LC1 export) into a dedicated `reports` hub, mirroring the Tenant Ops "Reports & Exports" hub. Same handlers, same queries.

4. **Verification Queue card stays** — the "Awaiting your verification / Houses / Landlords" card keeps its structure, counts, wording, targets and disabled behaviour; only spacing, radius, icon and typography are aligned to the shared card treatment. The `verify` view workflow is untouched.

5. **Restyle existing hub views** — every `view !== 'home'` branch gets the shared `HubHeader` (back + section title + Sections switcher) in place of the current lighter back row, plus consistent outer spacing. Inner panels, tables, filters, dialogs and actions are left exactly as they are.

6. **Overview grouping** — the dashboard becomes: sticky header, verification card, Priority hubs (the six moved panels + funded/location shortcuts), KPI grid, then the existing Priority and Management nav card grids. Grids stay `grid-cols-1` on mobile and widen at `sm`/`lg` as they do now.

7. **Responsive QA** — verify at 360px, 390px, 768px and desktop: no horizontal overflow, no clipped headers, back action always visible, tap targets stay at least 44px. Existing wide data tables keep their current horizontal scroll containers.

## Preserved exactly

Every query, RPC, mutation, bulk action, verification rule, permission check, dialog, form and validation stays byte-identical — panels are re-parented, not rewritten. No section is removed; the six moved panels remain one tap away with counts on the overview.

## Technical notes

- Only `src/components/executive/LandlordOpsDashboard.tsx` is restructured, plus two new shared files under `src/components/ops/` and the mechanical swap of `renderHubEntry`/back-row markup in `src/components/executive/TenantOpsDashboard.tsx`.
- New `View` union members: `agent-verify-requests`, `lc1-inbox`, `rent-pipeline-queue`, `rejected-queue`, `payout-review`, `agent-capacity`, `reports`.
- `enabled:` flags on existing queries are widened only where a panel's data now loads inside its hub instead of on `home`, so counts on the overview keep working while heavy panel queries no longer run on the dashboard.
- `renderDialogs()` is mounted in each new hub view so dialog-driven actions keep working.
