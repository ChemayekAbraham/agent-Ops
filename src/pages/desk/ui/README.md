# Desk UI kit

One version of each piece the ops desks (`/desk/*`) are built from. Import from `src/pages/desk/ui`, never re-style a local copy. If a desk needs something the kit lacks, add it here.

**The rule: copy the command centre.** Every desk should read like `/desk/command`: the same page ground, cards, titles, figures and spacing. When in doubt, open the command centre and match it. The measurements are written down in "The command centre reference" below.

| Piece | Use it for |
|---|---|
| `GradeBadge` | Any grade: A green, B teal, C amber, D red, N grey "New", X black "Blocked", none grey "Not graded". `agentGrade.tsx` wraps it with the grade pop-up and the week-on-week arrow. |
| `DecisionButton` / `MenuItem` | Every button. Variants: `primary`, `quiet`, `danger`, `warn`, `ok`. |
| `Chip` / `CountChip` | Flags, states and counts. Tone `idle` / `ok` / `warn` / `bad`. |
| `Segmented` | Period, scope and sort toggles, and filters that can be cleared (`deselectable`). |
| `Card` / `CardTitle` / `BriefLines` | Every section: the command centre's panel, or its "Today on Welile" brief (`variant="brief"`). |
| `Tile` / `TileRow` | Big figures, as in the command centre's balance strip. `trend` adds the 24-hour arrow. `TileRow phone={1}` for long UGX figures. |
| `TrendArrow` | The river's 24-hour change: up red and down green on a queue (`upIsGood` flips it). |
| `StripStep` | One stage in the pipeline strip, as a small river capsule. |
| `Fold` | Collapsible sections, drawn as a card. `count` shows a count chip, `changed` the amber "changed this week" dot. Closed folds mount nothing and query nothing. |
| `DeskPopover` / `MoreMenu` | Pop-ups and the row "…" menu. They render inside `.desk-root`, so the desk theme reaches them. |
| `LoadingRows` · `ErrorLine` · `EmptyState` | The three states besides "has data". |

## The command centre reference

### Tokens

Every token below is on `.desk-root` in `index.css`. Light redefines the surface tokens; the sizes are the same in both themes.

| Token | Value | Used for |
|---|---|---|
| `--desk-space-1` … `-6` | 4 · 8 · 12 · 16 · 20 · 24 px | the only spacing steps |
| `--desk-card-pad` | 20px | padding inside a card |
| `--desk-card-gap` | 14px | between a card's title and body |
| `--desk-section-gap` | 24px | between sections on a page |
| `--desk-radius-card` | 24px | cards, folds, sheets |
| `--desk-radius-tile` | 18px | figure tiles |
| `--desk-radius-capsule` | 16px | river capsules, strip steps |
| `--desk-primary-solid` / `-hover` / `-fg` | light: `263 70% 50%` → `263 72% 42%` · dark and Board: `265 72% 56%` → `265 72% 48%` · white text | the solid primary button |
| `--desk-card-fill` / `--desk-card-line` / `--desk-card-shadow` | dark: 5% white glass, 7% white edge, inset highlight · light: white paper, `#e7e4f0` edge, 1px soft lift | card surface |
| `--background`, `--foreground`, `--muted-foreground`, `--primary` | as set per theme | page ground, text, grey text, brand |
| `--desk-ok` / `--desk-warn` / `--desk-bad` | green / amber / red | status only, never decoration |

### Type

| What | Size | Board mode |
|---|---|---|
| Section title (card, fold) | 16px semibold | 18px |
| Body text, brief lines, empty states | 14px, snug leading | 16px |
| Labels, footnotes (`.desk-label`) | 13px at 70% | 13px |
| Chips | 11px (`xs`) or 12px (`sm`) | same |
| Tile figure | 36px, or 28px when the figure is longer than 11 characters | 44px / 36px |
| Capsule figure (river) | 40px | 52px |

### Cards

- **Panel** (`Card`): 24px corners, 20px padding, 14px between title and body.
- **Brief** (`Card variant="brief"`): the same shell with 8px between lines, at most three sentences, and a footnote ("As at 09:30 Kampala · refreshes every 5 minutes").
- **Tile**: 18px corners, 16px padding, 8px between label, figure and the line under it.
- **Capsule**: 16px corners, 16px padding (20px on a board), 10px between parts.
- **Panels inside an open Fold** lose their own glass, so a table reads as part of its card.
- **Sections stack 24px apart**, and grids of cards are 24px apart. Tiles in a row are 12px apart.

### Density

"Comfortable" is the default (the toolbar's Compact / Comfortable switch). The measurements above are the comfortable ones; only table rows tighten in Compact.

### Theme

- **Light is the default on every desk.** If someone has never chosen, they get light; the device's dark setting is not consulted.
- **The toolbar's Light/Dark toggle** saves the choice (`desk-theme` in local storage), and a saved choice wins.
- **Board mode is always dark**, whatever was saved. (`resolveDeskTheme` in `deskPrefs.tsx`.)
- **A sheet that opens its own `.desk-root`** follows the page's theme.

## Responsive

### Breakpoints

`ui/breakpoints.ts` is the only source; `index.css` repeats the numbers, and a test checks they agree.

| Band | Width | What changes |
|---|---|---|
| xs | < 360 | Segmented becomes a native select; the LIVE pill is a dot |
| sm | 360–599 | One sticky header bar (≤ 56px), "Desk ▾" switcher, "Pipeline ▸" chip, DataList as cards |
| md | 600–1023 | Header on two rows with the tabs; DataList as a table; density and staff ID in "⋯" |
| lg | 1024–1439 | Light/Dark and Board mode in the bar |
| xl | ≥ 1440 | The whole toolbar inline |
| wall | ≥ 1920 | Board mode on a wall |

### Pieces

- **`DataList`**: one column definition (`priority` 1–3) gives a table from md and cards below. Priority 1 is always on the card, priority 2 a small line, priority 3 under "More". It has search, "Show 10 / Show all", and the three states built in.
- **`RowCard`**: the phone card for a decision row. The primary label stays at 24 characters or fewer (`splitDecisionLabel` moves "→ target" to the line under it). Three chips show, then "+n".
- **`Sheet`**: a bottom sheet on a phone and a centred card from md. Used by the desk switcher, the pipeline stages and the "⋯" menu.
- **`format`**: on cards, write `daysShort` ("152 d", "<1 d"), `moneyCard` ("UGX 1.2M") and `pctWhole` ("65%"). On tables and in tooltips, write `moneyFull`.
- **`plainReason` / `Reason`**: rule codes (AO-6, SC-1, …) leave the sentence and stay in the tooltip.

### Rules

- **No horizontal page scroll at any width, or at 200% zoom.** Rows wrap; tables and pill rows scroll inside their own box.
- **Tiles** fit themselves (`minmax(150px, 1fr)`, at least two across a phone). Figures are `clamp(22px, 5vw, 36px)`, and long money shortens with the full value in the tooltip.
- **Segmented never wraps.** It scrolls with fade edges and keeps the pressed option in view.
- **Touch and type:** targets are at least 44px, and body text at least 14px on phones.
- **Motion:** respect `prefers-reduced-motion`.

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
- **`primary` is the only solid button**: the brand violet fill (`--desk-primary-solid`), white semibold text (`--desk-primary-solid-fg`), a darker fill on hover (`--desk-primary-solid-hover`), and the 2px focus ring. White on the fill is 7.2:1 in light, 5.7:1 in dark and Board mode, and 7.5:1 or more on hover. `kit.test.tsx` checks it stays at least 4.5:1. Everything else stays tinted, so the main move is the one thing on a row that reads as a button rather than a label.
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
