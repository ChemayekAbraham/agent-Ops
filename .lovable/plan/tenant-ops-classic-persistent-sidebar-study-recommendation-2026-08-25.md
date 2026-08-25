# Tenant Ops → Classic: persistent sidebar (study + recommendation)

No code changed. This is the findings report and one recommended approach.

## What exists today

**Tenant Operations is reached at `/executive-hub?tab=tenant-ops`.** `ExecutiveHub` picks the dashboard from `?tab=`, checks the `tenant-ops` staff permission, and renders `TenantOpsHub` inside the standard header (back button, title, budget bell, guide download). `partners-ops` is the only tab that hides that header and renders full width.

**`TenantOpsHub`** is a thin wrapper with:
- a 3-way workspace switcher — **New** (`TenantOpsDashboardV2`: Inbox / Segments / Search tabs), **Operations Intelligence** (`TenantOpsGeoCommandCenter`), **Classic** (`TenantOpsDashboard`) — persisted in `localStorage` under `tenant-ops-view-mode`, not in the URL.
- always-on items above the switcher: agent-inactive alert banner, phone-duplicate summary card (expands to a full "duplicates hub" that replaces the whole screen), and three secondary buttons: Locations, Word Report, Welile Homes (bottom sheet).

**Classic (`TenantOpsDashboard`, ~1.9k lines)** is already a single-view router, not tabs. One `activeView` state with ~29 values; `overview` shows everything, any other value shows one full-width working view with a "Back to Overview" row. The overview stacks: two hero cards (Global Verification Center, Welile Operations), a legacy landlord-float card, a sticky mobile quick-action strip (Collect / Review / Today / Missed), **Tenant Ops Tools** (≈18 `navCards` tiles with live badges), **Workspaces** (6 `HubEntryCard` tiles: Pipeline Status, Agent Rent Capacity, All Tenants, Daily Collection Monitoring, Repayment Reliability, Reports & Exports), a pipeline-status strip, and a reports/extract toolbar. Badges and stats come from `useTenantOpsToolCounts` (single server RPC). Dialogs (location, delete, tenant detail) are mounted at the root.

**Partner Ops sidebar (the reference)** is three files:
- `partner-ops/partnerOpsNav.ts` — a typed `PartnerOpsViewKey` union plus a `PARTNER_OPS_NAV` array of leaf items and groups with `children`, each with icon, label and search `keywords`, and a `searchPartnerOpsNav()` helper.
- `partner-ops/PartnerOpsSidebar.tsx` — `ScrollArea` list; leaves are pill buttons (`bg-primary text-primary-foreground` when active), groups render an uppercase muted label with an indented child list (`bg-primary/10 text-primary` when active), a small destructive-tinted count badge, and hairline dividers between groups.
- `partner-ops/PartnerOpsTopBar.tsx` — sticky top bar with a hamburger that opens the same sidebar in a left `Sheet` under `lg`, a section search box with a dropdown of matches, user chip, budget bell and an `actions` slot.
- `PartnersOpsDashboard.tsx` — `useState<PartnerOpsViewKey>('overview')`, a `renderView()` switch, and the shell: `<aside className="hidden w-56 shrink-0 lg:block">` with a sticky full-height card, content in `flex-1 min-w-0`. Dialogs always mounted. **State only — no URL sync**, so deep links and browser back/forward do not restore a Partner Ops section.

Important constraint on file: project memory records that Tenant Ops **Classic must never be modified, redesigned or replaced** (set when the geo drill-down was reverted). So the sidebar should be an additive shell around Classic's existing views, and ideally shipped as its own workspace mode, not a rewrite of the overview.

## Recommended structure

Sidebar sections (mirroring Partner Ops shapes, using Classic's own view keys):

- **Home** (leaf) — new landing page.
- **Verification & Users** — Global Verification Center, Welile Operations, Phone Duplicates, Registration Review.
- **Tenant Ops Tools** (group, expandable) — the existing ~18 `navCards`: Review Requests, Daily Payments, Missed Days, Tenant Behavior, Approval History, All Requests, Link Agent, Transfer Audit, Collect Rent, Search by Agent, Business Advances, Agent Allocations, Agent Landlord Float, Float Timeline, Browse by Location, Daily Rent Repayments.
- **Workspaces** (group, expandable) — Pipeline Status, Agent Rent Capacity, All Tenants, Daily Collection Monitoring, Repayment Reliability, Reports & Exports.
- **Reports & Tools** — Reports & Exports hub, Word Report (action), Locations (navigates out), Welile Homes (sheet).

Clicking any item renders only that view next to the persistent sidebar; `Home` renders the landing page.

### Home landing page (reuse, don't invent)

- The two hero cards (Global Verification Center, Welile Operations) exactly as they are.
- Alert row: agent-inactive banner + phone-duplicate summary card.
- KPI strip from `useTenantOpsToolCounts`: pending / in pipeline / funded, expected vs collected today, tenants paid vs unpaid, missed-days and critical-behaviour counts.
- Pipeline-status strip (each tile deep-links into the Pipeline Status hub with its status seed).
- Top-priority shortcuts: Review Requests, Collect Rent, Missed Days, Daily Payments (the existing quick-actions), each with its live badge.
- Reports/extract toolbar entry point.

Nothing new needs to be computed — every number above already exists.

### Visual match

Reuse the Partner Ops classes verbatim: `w-56` desktop aside, sticky `h-[calc(100vh-4rem)]` card, `ScrollArea`, `text-xs` labels, `rounded-lg px-2.5 py-2` rows, active = `bg-primary text-primary-foreground` (leaf) / `bg-primary/10 text-primary` (child), uppercase muted group headers, `h-px bg-border/60` dividers, destructive-tinted numeric badges. Semantic tokens only — no new colours. Existing `HubEntryCard` / `HubHeader` in `src/components/ops/` stay in use for the landing tiles and for the in-view back row on mobile.

### Responsive behaviour

- `lg` and up: persistent sidebar + content, same as Partner Ops.
- Below `lg`: sidebar hidden, opened from a hamburger in a left `Sheet`; selecting an item closes the sheet. Keep the existing sticky mobile quick-action strip on Home.
- Content column keeps `min-w-0` so today's wide tables keep their own horizontal scroll.

### Routing (improve on Partner Ops here)

Partner Ops keeps section state in memory only. For Tenant Ops, sync to the URL so links, refresh and back/forward work:

- `?tab=tenant-ops` (unchanged) + `&mode=classic|v2|intel` + `&view=<sectionKey>`.
- `mode` is read from the URL first and falls back to the existing `localStorage` value, so the New / Operations Intelligence / Classic tabs and anything else on that switcher keep working untouched.
- Selecting a section calls `setSearchParams(..., { replace: false })` so browser back returns to the previous section; unknown `view` falls back to Home.
- Existing deep links (`/executive-hub?tab=locations`, `?section=` handling in `ExecutiveDashboardLayout`) are untouched.

## Reuse, don't recreate

`HubEntryCard`, `HubHeader`, `ScrollArea`, `Sheet`, `Button`, `Card`, `Badge`, `useTenantOpsToolCounts`, all Classic view components (`RentPipelineQueue`, `PipelineStatusHub`, `DailyPaymentTracker`, `MissedDaysTracker`, `GlobalVerificationHub`, `TenantPhoneDuplicatePanel`, `WelileHomesAdminPanel`, …), and the Partner Ops sidebar trio as the copy source.

## Recommended approach (one)

Wrap — don't rewrite — Classic:

1. Add `src/components/executive/tenant-ops/tenantOpsNav.ts`: `TenantOpsViewKey` union built from Classic's existing `ActiveView` values, `TENANT_OPS_NAV` groups (Home, Verification & Users, Tenant Ops Tools, Workspaces, Reports & Tools), and a `searchTenantOpsNav()` helper — a direct adaptation of `partnerOpsNav.ts`.
2. Add `TenantOpsSidebar.tsx` and `TenantOpsTopBar.tsx` under the same folder, copied from the Partner Ops versions with the Tenant Ops nav wired in (search box, hamburger `Sheet`, badges from `useTenantOpsToolCounts`).
3. Add `TenantOpsClassicShell.tsx`: owns `view` (URL-synced), renders sidebar + top bar, renders `TenantOpsHome` for Home and otherwise renders `TenantOpsDashboard` in controlled mode.
4. Make `TenantOpsDashboard` **controllable, not restructured**: add optional props `view`, `onViewChange`, `hideOverview`. When provided, it uses the parent's view instead of its own state and skips rendering the overview block. Every existing `renderSubView()` case, query, dialog and handler is left byte-identical, so standalone Classic still works.
5. Add `TenantOpsHome.tsx` composed of the existing hero cards, alert row, KPI strip, pipeline strip and shortcuts.
6. Update `TenantOpsHub.tsx` only to read/write `mode` and `view` in the URL and to render the new shell for Classic; the New / Operations Intelligence switcher and the Locations / Word Report / Welile Homes actions move into the shell's top-bar `actions` slot unchanged.

Files touched: `TenantOpsHub.tsx` (small), `TenantOpsDashboard.tsx` (additive props only), plus new `tenant-ops/tenantOpsNav.ts`, `TenantOpsSidebar.tsx`, `TenantOpsTopBar.tsx`, `TenantOpsClassicShell.tsx`, `TenantOpsHome.tsx`. No backend, permission, query or workflow changes.

Note: because project memory freezes Classic, step 4 is deliberately limited to additive optional props. Confirm that is acceptable, or say the word and the shell can instead render Classic's views through a new component without touching that file at all.
