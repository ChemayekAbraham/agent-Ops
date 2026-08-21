# CFO Dashboard Layout Refinement

## Goal
Rearrange the CFO home page so the **Revenue — Last 7 Days** and **Advances — Disbursed vs Recovered** cards sit side-by-side on a single horizontal row with equal width and aligned heights, and the **CFO Actions Log** sits directly underneath them spanning the full width of the dashboard section. All existing content, data bindings, calculations, and styling must remain unchanged; only layout, sizing, spacing, and positioning may be modified.

## Current state
In `src/components/cfo/CFOOverviewDashboard.tsx`:
- The Revenue and Advances cards are inside a `grid-cols-1 md:grid-cols-2` container at the bottom of the left-hand column (`xl:col-span-2`) of a two-column shell (`xl:grid-cols-3`).
- `<CFOActionsLog />` is rendered immediately after those cards, still inside the left-hand column, so it is constrained to roughly two-thirds of the dashboard width and sits beside the right-hand feed column rather than below the cards.

## Proposed change
Move the Revenue/Advances card group and the CFO Actions Log out of the two-column shell so they become full-width rows within the main `max-w-7xl` container.

```text
Current:
├─ 3 headline cards (full width)
├─ two-column shell
│  ├─ left col (2/3)
│  │  ├─ Treasury / Bank cards
│  │  ├─ Financial Summary
│  │  ├─ Revenue | Advances cards
│  │  └─ CFO Actions Log   ← constrained to left col
│  └─ right col (1/3)
│     └─ ROI / Ledger / Cash feeds

Proposed:
├─ 3 headline cards (full width)
├─ two-column shell
│  ├─ left col (2/3)
│  │  ├─ Treasury / Bank cards
│  │  └─ Financial Summary
│  └─ right col (1/3)
│     └─ ROI / Ledger / Cash feeds
├─ Revenue — Last 7 Days | Advances — Disbursed vs Recovered  (full-width 2-col row)
└─ CFO Actions Log                                            (full width)
```

## Implementation steps
1. In `src/components/cfo/CFOOverviewDashboard.tsx`, locate the `{/* ══════════════ CHARTS ══════════════ */}` block and the `{/* ══════════════ CFO ACTIONS LOG ══════════════ */}` block.
2. Move both blocks out of the left-hand `xl:col-span-2` column and place them after the closing `</div>` of the two-column shell but still inside the outer `max-w-7xl mx-auto` container.
3. Keep the existing `grid grid-cols-1 md:grid-cols-2 gap-4 items-stretch` wrapper on the Revenue/Advances cards so they remain equal-width and height-aligned.
4. Preserve all card content, chart data, tooltips, legends, and the `<CFOActionsLog />` invocation exactly as-is.
5. Verify the build passes and the visual result matches the requested layout.

## Files to edit
- `src/components/cfo/CFOOverviewDashboard.tsx`

## Out of scope
- No changes to data fetching, calculations, chart configuration, or business logic.
- No changes to the CFO Actions Log component itself.
- No styling changes beyond layout/spacing/positioning.
