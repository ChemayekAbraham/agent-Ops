# Desk UI kit

One version of each piece the ops desks (`/desk/*`) are built from. Import from `src/pages/desk/ui`, never re-style a local copy. If a desk needs something the kit lacks, add it here.

| Piece | Use it for |
|---|---|
| `GradeBadge` | Any grade: A green, B teal, C amber, D red, N grey "New", X black "Blocked", none grey "Not graded". `agentGrade.tsx` wraps it with the grade pop-up and the week-on-week arrow. |
| `DecisionButton` / `MenuItem` | Every button. Variants: `primary`, `quiet`, `danger`, `warn`, `ok`. |
| `Chip` / `CountChip` | Flags, states and counts. Tone `idle` / `ok` / `warn` / `bad`. |
| `Segmented` | Period, scope and sort toggles, and filters that can be cleared (`deselectable`). |
| `Tile` / `TileRow` | Big figures. `TileRow phone={1}` for long UGX figures. |
| `Fold` | Collapsible sections. `count` shows a count chip, `changed` the amber "changed this week" dot. Closed folds mount nothing and query nothing. |
| `DeskPopover` / `MoreMenu` | Pop-ups and the row "…" menu. They render inside `.desk-root`, so the desk theme reaches them. |
| `LoadingRows` · `ErrorLine` · `EmptyState` | The three states besides "has data". |

## The frame

Every stage desk runs in this order:

1. Pipeline strip
2. Lead line and tiles
3. **Ready for your push** (the board)
4. Waiting on… (collapsed)
5. Done today (collapsed)
6. Rules for this desk (collapsed)
7. Classic view (collapsed). It holds every table the desk had before.

New sections go between 3 and 7, and they start collapsed.

## One main button per row

- **One `primary` per row.** It carries out the decision the rules reached. Use `decisionVariant(decision)`: a reject gets `danger`, everything else `primary`.
- **Main-button wording** (`DECISION_WORDS`): **Pass** · **Send back** · **Reject** · **Transfer → …** · **Call …** · **Finish checks** · **Wait …**. The "…" part names who or what.
- **Every other move goes in the row's `MoreMenu`.** Moves that need a reason end in "…" and open the review.
- **Sheets that run a batch** confirm with `ok` ("Push all 12") and close with `quiet` ("Done").

## Wording

- **Required terms:** say "Rent Plan" (never "loan"), "Supporter" (never "lender") and "Returns" (never "ROI" or "interest").
- **No budget words** on any desk: the COO and CFO budgets are retired, and funders take requests from the board.
- **Short plain sentences.** Figures read "UGX 1,200,000", and day counts read "3 d".
- **Errors:** say what failed, then the server's words as-is. For example: "The board could not load: …".
- **Empty states:** say what would be here. For example: "Nothing is waiting at this desk."

## States

| State | Piece | Rule |
|---|---|---|
| Loading | `LoadingRows` | Shimmer bars in the shape of the content, so nothing jumps when it lands. |
| Error | `ErrorLine` | One red line with `role="alert"`. A missing RPC hides the section instead of showing an error. |
| Empty | `EmptyState` | One grey line. |
| Changed | `Fold changed` | The amber dot, with the label "Changed this week". |

## Colour, theme and Board mode

- **Colours come only from `.desk-root` tokens.** Status uses `--desk-ok` / `--desk-warn` / `--desk-bad` (via `statusGlass`, `statusText` and `statusDot`). Grades use `--desk-emerald` … `--desk-blocked`. Brand uses `--primary`.
- **No Tailwind palette classes** (`bg-emerald-600`, `bg-black`, …) and **no hex values**. `kit.test.tsx` fails if one appears.
- **Light and dark** both come from the same tokens, and `data-desk-theme="light"` redefines them.
- **Board mode** is always dark. Pass `board` to get the larger type.

## Late-CSS safety

`main.tsx` loads `index.css`, which holds every Tailwind utility, in the background after first paint. So every kit piece sets its display, flex, gap, padding and nowrap **inline**, the way `DeskTabs` does. Classes carry only colour, type and state.

## Mobile (375 px)

- **Rows wrap, they don't squeeze.** Pills never wrap their text (`nowrap`).
- **The main button sits at the end of a row and wraps to its own line** when space runs out.
- **Tables with many columns scroll sideways inside their panel.** The page itself never scrolls sideways.
- **Tiles:** 2 across for counts, 1 across for UGX figures (`TileRow phone={1}`).
- **Touch targets:** every button and link is at least 44 px tall (global rule in `index.css`).
