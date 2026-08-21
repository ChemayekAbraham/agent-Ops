# CFO Home Page Card Restyle

## Goal
Restyle the three cards on the CFO Overview dashboard — **Revenue — Last 7 Days**, **Advances — Disbursed vs Recovered**, and **CFO Actions Log** — so the two chart cards sit cleanly side-by-side on one horizontal row with equal width and consistent height, and the Actions Log spans the full width directly underneath. All existing data, calculations, hooks, charts, and interactions must remain unchanged.

## What will change
- Layout and visual styling only.
- No data sources, RPC calls, calculations, or business logic will be touched.
- No backend/schema changes.

## Implementation plan

### 1. Re-layout the CFO Overview surface
**File:** `src/components/cfo/CFOOverviewDashboard.tsx`

- Extract the **Revenue — Last 7 Days** and **Advances — Disbursed vs Recovered** cards from the existing `lg:grid-cols-2` block inside the left column.
- Place them in a dedicated top row: `grid grid-cols-1 md:grid-cols-2 gap-4` so they are always equal-width on desktop and stack cleanly on mobile.
- Move `<CFOActionsLog />` out of the right-hand feed column and place it **directly underneath** the two chart cards in a full-width container (`w-full`).
- Keep the remaining dashboard content (Financial Summary, Today's Money Flow, ROI forecast, Ledger Maintenance, Cash Sources, Auto Payments, Agent Advances) intact; only the order/position of these three cards changes.

### 2. Equalise card height and padding
- Wrap each chart card in `Card` with `h-full flex flex-col`.
- Give `CardContent` `flex-1 flex flex-col` so the chart area expands to fill available height.
- Standardise the chart container height to a single value (e.g., `h-64`) for both cards.
- Apply consistent internal padding (`p-4 sm:p-5`) and rounded corners (`rounded-2xl`) to both cards.

### 3. Unify headers and typography
- Use the same header pattern for both chart cards:
  - Left: title in `text-sm font-semibold tracking-tight`.
  - Right: compact meta label/badge in `text-[11px] text-muted-foreground`.
- Keep the existing Revenue chart legend/UGX hint and the Advances recovery-rate badge, but style them with the same right-side meta slot.
- Ensure title baseline and meta baseline align across both cards.

### 4. Style the CFO Actions Log to match
**File:** `src/components/cfo/CFOActionsLog.tsx`

- Update the outer `Card` to use the same `rounded-2xl` radius and `shadow-sm` as the chart cards.
- Keep the existing header (filters, search, exports) but align its title/header row visually with the chart cards (same font weight/tracking, same padding).
- Ensure the card spans the full available width of the main content area and has consistent horizontal padding.

### 5. Verify no logic drift
- Confirm `useCFOOverviewData` and `AgentAdvancesTrendChart` hooks remain wired exactly as before.
- Confirm `CFOActionsLog` still receives no props and manages its own state.
- Run `tsgo` to ensure type safety and `bun run build` (or the harness build) to confirm no runtime errors.
- Spot-check the preview at desktop and mobile widths to confirm:
  - Two chart cards are side-by-side and equal width on `md`+.
  - Both cards have the same height.
  - CFO Actions Log sits directly below them and spans the full width.
  - Existing interactivity (breakdown sheets, toggles, exports, pagination) still works.

## Technical details
- Uses existing shadcn/ui `Card` / `CardContent` components and Tailwind semantic tokens (`bg-card`, `border-border`, `text-muted-foreground`, etc.).
- No custom hex colors or hardcoded values.
- No new dependencies.
