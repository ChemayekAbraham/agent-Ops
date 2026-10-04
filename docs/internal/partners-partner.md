# PROMPT FOR AI AGENT: Replicate the COO Partners Page UI

You are building a **Partners Management Page** that must exactly replicate the design system, layout, and interaction patterns from the existing COO Partners Page (`src/components/coo/COOPartnersPage.tsx`). Follow these specifications precisely:

---

## 1. PAGE STRUCTURE (Top → Bottom)

### A. Page Header
- `<h1>` with `text-xl sm:text-2xl font-black tracking-tight` → "Partner Management"
- Subtitle: `text-sm text-muted-foreground mt-0.5`
- Right-aligned `<Button variant="outline" size="sm">` with `RefreshCw` icon + "Refresh" label
- Use `flex flex-col sm:flex-row sm:items-center justify-between gap-3`

### B. Summary Cards Row
- Grid: `grid grid-cols-2 lg:grid-cols-4 gap-3`
- Each card is a `SummaryCard` component with this exact structure:
```tsx
<div className={cn('rounded-2xl border p-4 space-y-1', `border-${accent}-500/30 bg-${accent}-500/5`)}>
  <div className="flex items-center gap-2">
    <div className={cn('p-1.5 rounded-lg', `bg-${accent}-500/15`)}>{icon}</div>
    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{label}</p>
  </div>
  <p className="text-xl font-black tracking-tight tabular-nums">{value}</p>
  <p className="text-[10px] text-muted-foreground">{sub}</p>
</div>
```
- 4 cards: Total Partners, Total Funded, Wallet Balances, Avg ROI Rate
- Accent colors: `primary`, `emerald`, `amber`, `violet`

### C. Filters Bar
- Container: `flex flex-wrap items-center gap-2`
- **Search input**: Relative container with `Search` icon (lucide) positioned `absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5`. Input: `h-9 w-full rounded-lg border border-border bg-background pl-8 pr-8 text-sm`. Clear button with `X` icon when search is active. Wrapper: `flex-1 min-w-[180px] max-w-xs`
- **Status filter**: `<Select>` with `<SelectTrigger className="w-[120px] h-9 text-xs">` containing a `<Filter>` icon. Options: All Status, Active, Suspended
- **ROI Mode filter**: `<Select>` with `<SelectTrigger className="w-[140px] h-9 text-xs">`. Options: All Modes, Payout, Compounding
- **Import button**: `<Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs">` with `Upload` icon
- **Activate All button** (conditional): `<Button size="sm" className="h-9 gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white">` with `CheckCircle2` icon. Only shows when `pendingApprovalCount > 0`
- **Export CSV button**: `<Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs ml-auto">` with `Download` icon

### D. Data Table
- Container: `rounded-xl border border-border bg-card shadow-sm overflow-hidden`
- Inner: `overflow-x-auto` wrapping a `<table className="w-full text-xs sm:text-sm min-w-[640px]">`
- **thead**: `<tr className="border-b-2 border-border bg-muted/60">`
  - First column `#`: `px-2 sm:px-3 py-2.5 text-[9px] sm:text-[10px] font-black uppercase tracking-widest text-muted-foreground text-center w-10`
  - Other headers: same font styles, with `cursor-pointer hover:text-foreground hover:bg-muted/70 transition-colors` when sortable
  - Each sortable header has an inline sort icon (`ChevronsUpDown` default, `ChevronUp`/`ChevronDown` when active, colored `text-primary`)
  - Some columns get `hideOnMobile` → add `hidden sm:table-cell` class
- **tbody**: `divide-y divide-border/30`
  - Row: alternating `bg-card` / `bg-muted/20`, hover `hover:bg-primary/[0.06]`, `cursor-pointer active:bg-primary/10 transition-colors`
  - Row number cell: `text-[9px] sm:text-[10px] font-bold text-muted-foreground/60 text-center tabular-nums`
  - Data cells: `px-2 sm:px-3 py-2 tabular-nums border-l border-border/20` with `text-right font-semibold tracking-tight` for number columns
  - Empty state: single row spanning all columns, `px-3 py-12 text-center text-sm text-muted-foreground italic`
- **tfoot**: `<tr className="border-t-2 border-border bg-muted/40">` showing record count like `23 RECORDS TOTAL` in `text-[9px] sm:text-[10px] font-black text-muted-foreground uppercase tracking-widest`

### E. Pagination Bar
- Only render when `totalPages > 1`
- Container: `flex items-center justify-between px-2 sm:px-3 py-1.5 border-t border-border/60 bg-muted/30`
- Left: range text `1–15 OF 23` in `text-[10px] sm:text-[11px] font-bold text-muted-foreground tabular-nums tracking-wide`
- Right: `<ChevronLeft>` and `<ChevronRight>` buttons with `p-1 rounded hover:bg-muted disabled:opacity-20 active:scale-95 transition-colors`, page indicator `1/2` in `text-[10px] font-bold tabular-nums text-muted-foreground px-1.5`

---

## 2. TABLE COLUMNS

| Column | Key | Align | Mobile | Render |
|--------|-----|-------|--------|--------|
| Partner | `name` | left | ✅ | Name as `font-semibold text-foreground truncate` with `group-hover:text-primary underline-offset-2 group-hover:underline`. Phone below in `text-[10px] text-muted-foreground` |
| Status | `status` | left | ✅ | Badge: `inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider`. Active = `bg-primary/10 text-primary` with `bg-primary` dot. Suspended = `bg-destructive/15 text-destructive` with `bg-destructive` dot |
| Wallet | `walletBalance` | right | ✅ | `font-semibold tabular-nums`. Green (`text-primary`) if ≥ 50000, else `text-muted-foreground` |
| Total Funded | `funded` | right | ✅ | `font-semibold tabular-nums` |
| Deals | `activeDeals` | right | ❌ hidden sm | Plain number |
| ROI | `roiPercentage` | right | ✅ | `font-bold text-primary` with `%` suffix |
| Mode | `roiMode` | left | ❌ hidden sm | Pill: `px-2 py-0.5 rounded-full text-[10px] font-semibold`. Compounding = `bg-primary/10 text-primary`, Payout = `bg-muted text-muted-foreground` |
| Payout | `payoutDay` | right | ❌ hidden sm | Day with ordinal suffix in `text-muted-foreground` |
| Actions | — | — | ✅ | `<DropdownMenu>` with `<MoreHorizontal>` trigger. Items: Edit Partner, Invest, Suspend/Reactivate, Delete Partner |

---

## 3. PARTNER DETAIL VIEW (Inline, replaces table)

When a partner row is clicked, show detail view with:
- **Back button**: `flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4 active:scale-95` with `<ChevronLeft>` icon
- **Partner header**: Name in `text-lg sm:text-xl font-black tracking-tight`, phone below, status badge, joined date
- **KPI Cards Row**: `grid grid-cols-2 lg:grid-cols-4 gap-3` — Wallet Balance, Total Funded, Total Deals, Total ROI Earned. Each uses the same `SummaryCard` pattern
- **Action buttons row**: `flex flex-wrap gap-2` with buttons: "Add Portfolio" (primary), "Fund Wallet" (outline), "PDF Report" (outline), "Share via WhatsApp" (outline)
- **Portfolios list**: Each portfolio in a `rounded-xl border border-border bg-card p-4 space-y-3` card showing:
  - Portfolio code as `font-mono text-xs bg-muted px-2 py-0.5 rounded`
  - Account name (editable inline)
  - Investment amount, ROI %, Duration, Payout day, Status, Maturity date, ROI earned
  - Each field: `flex items-center justify-between py-1.5` with label in `text-xs text-muted-foreground` and value in `text-sm font-semibold`
  - Action buttons per portfolio: Edit, Renew, Delete, Top-Up, Wallet→Portfolio transfer, Apply Pending

---

## 4. DIALOG PATTERNS

All dialogs use shadcn `<Dialog>` / `<AlertDialog>`:
- `<DialogContent className="sm:max-w-md">` for forms
- Form inputs: `<Input>` with `<Label>` above
- Amount fields: `type="number" min="50000" step="1000"`
- Buttons: Primary action = `<Button>`, Cancel = `<Button variant="outline">`
- Loading state: `<Loader2 className="h-4 w-4 animate-spin mr-2" />` inside button, button `disabled` during operation
- Destructive actions (delete/suspend): Use `<AlertDialog>` with red-accented description, require reason textarea with minimum 10 characters

---

## 5. RESPONSIVE RULES

- **Mobile (< 640px)**: 2-column summary grid, hide `Deals`, `Mode`, `Payout` columns (`hidden sm:table-cell`), table min-width `640px` with horizontal scroll, all text sizes use the smaller variant (e.g., `text-xs` not `text-sm`)
- **Tablet (640-1024px)**: Show all columns, 2-column summary grid
- **Desktop (> 1024px)**: 4-column summary grid, full table

---

## 6. DESIGN TOKENS (MANDATORY)

- **NEVER** use raw colors like `text-white`, `bg-black`, `text-green-600` in components
- Use semantic tokens: `text-primary`, `text-foreground`, `text-muted-foreground`, `text-destructive`, `bg-card`, `bg-muted`, `bg-background`, `border-border`
- Exception: accent colors for summary cards use Tailwind palette with opacity (`bg-emerald-500/5`, `border-amber-500/30`, etc.)
- All icons from `lucide-react`
- Currency formatting: `formatUGX()` from `@/lib/rentCalculations`
- All shadcn components from `@/components/ui/*`

---

## 7. STATE MANAGEMENT

- All state is local (`useState`), no global store
- Data fetching via `supabase` client, wrapped in `useCallback` with `try/catch/finally`
- Loading state: `<Loader2>` spinner centered with `flex items-center justify-center py-20`
- Toast notifications via `sonner` (`toast.success()`, `toast.error()`)
- Pagination: `PAGE_SIZE = 15`, calculate `totalPages`, `safePage`, slice data

---

**DO NOT** deviate from these specifications. Every className, every spacing value, every component choice must match exactly.
