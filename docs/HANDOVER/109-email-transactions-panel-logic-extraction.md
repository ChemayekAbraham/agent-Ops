# 109 — Extracted Email Transactions panel logic into hooks/lib ahead of a UI rebuild

**Pure relocation, 2026-09-22 — no behavior change, not yet committed/deployed.** Before touching
`EmailTransactionsPanel.tsx`, `useEmailTransactionsPanel.ts`, or `emailTransactionsLogic.ts` again —
read this first so you don't reintroduce logic into the component or duplicate a helper that already
moved.

## What was asked

Josh: review Financial Ops' "Email Transactions" panel and rebuild the UI professional/minimal/sleek.
Per this repo's Claude/Gemini division of labor, the visual rebuild itself is Gemini's lane — my job
here was to extract every piece of business logic and data-fetching out of the 8,503-line
`EmailTransactionsPanel.tsx` into `src/hooks/`/`src/lib/` first, with **zero behavior change**, so
Gemini's pass can restyle the JSX without needing to understand or risk breaking the money logic
underneath it.

## What existed before

`EmailTransactionsPanel.tsx` was a single 8,503-line / 430KB file: state, ~20 `useEffect` data-fetch/
subscribe effects, channel-inference heuristics, auto-credit gate mirroring, routing/reversal/auto-debit
handlers, and ~5,000 lines of JSX were all interleaved in one component (plus several smaller trailing
components in the same file — `StatCard`, `GmailConnectionStatus`, `GmailReconnectAuditPanel`,
`DedupAuditPanel`, `DebugPollDialog`, `SmsSetupGuide`, `ReconnectGmailDialog`, `FixChannelDialog`,
CSV/PDF export helpers — those were **not** touched, see below).

## What changed

Three new files, zero logic changes — every moved function/effect/handler is byte-identical to the
original except for import paths and (where required) an added `export`:

- **`src/lib/emailTransactionsLogic.ts`** — pure, framework-free helpers with no React/Supabase
  dependency: `GmailTx`/`PollState` row types, `fmtUgx`, `isUnparsedRow`, `parseFailureReasons`,
  `autoCreditGateReport`, `zonedWallClockToUtcMs`, `dateKeyInTz`, `TIMEZONE_OPTIONS`,
  `isWelileOutboundEcho`, `validateGmailTx`, `extractCashReceiptCode`, the channel-cache
  read/write pair, `ChannelResult`/`ChannelConfidence`/`MatchedUser` types, `CHANNEL_RULES` (the
  ordered regex table), user-rule persistence (`StoredUserRule`, `readStoredUserRules` etc.),
  `computeChannel`/`deriveChannel`.
- **`src/hooks/useEmailTransactionsPanel.ts`** — every piece of state, effect, `useCallback`/
  `useMemo`, and handler that used to live directly in `EmailTransactionsPanel()` (filters, the
  `gmail_transactions` loader + realtime subscription, routing-history/credited-deposit/ledger-credit/
  manual-mark resolution, possible-user matching, withdrawal auto-matching, bulk mark, reverse-routing,
  auto-approve-withdrawal, alert tracking, filter presets, `visibleRows`/`channelBreakdown`/
  `dailySeries` derivations, etc.). Returns one object whose ~240 keys match the original component's
  local variable names exactly — the component destructures it and nothing downstream had to change
  names.
- **`src/hooks/useTelecomBalances.ts`** — the `TelecomBalanceStrip` sub-component's data fetch
  (MTN/Airtel float balance lookup), extracted the same way; `TelecomBalanceStrip` itself stays in
  `EmailTransactionsPanel.tsx` as a small presentational component now calling this hook.

`EmailTransactionsPanel.tsx` shrank from 8,503 → 5,242 lines. It now imports the hook, destructures
its full return value, and its `return (...)` JSX block — along with every trailing component after it
— is **completely untouched**, same line-for-line content as before.

## Why this was safe to do mechanically

The component's structure made the boundary clean: everything before its `return (` (originally lines
658–3441) was state/effects/handlers with no JSX; everything from `return (` onward (originally
3442–7156, plus the trailing standalone components through EOF) is JSX or JSX-only helpers, and none of
those redeclare `useState`/`useEffect` at the top level (deeper closures like the JSX-embedded
`runAutoDebit` auto-debit banner IIFE just close over whatever's in the enclosing component scope —
they didn't need to change at all, since the hook's destructured variables have the same names as the
values that used to be declared directly). Extraction was done with `sed` line-range extraction (not
hand-retyping) to guarantee byte-fidelity of the relocated logic, and the return/destructure lists were
generated programmatically from every top-level `const`/`let` binding in the extracted range, not
hand-enumerated — to avoid missing an identifier the JSX still needed.

Three types (`SortMode`, `PaginationMode`, `RoutingHistoryEntry`) were declared *inside* the original
component body but referenced by name later in the JSX/trailing components (`as SortMode`, a
`PaginationMode` type annotation, a `RoutingHistoryEntry` parameter type) — these are now exported
from `useEmailTransactionsPanel.ts` and imported into the panel file explicitly.

## Verification done

- `node scripts/guard-frontend-ledger-writes.mjs` — passes. Nothing in the moved code writes
  wallet/ledger tables directly; all money movement still goes through `cfo-direct-credit`/
  `approve-withdrawal` edge functions, unchanged.
- `npx esbuild` bundle-mode syntax check on all three new/changed files (bundles cross-file imports,
  not just a parse) — zero errors on each.
- Systematically grepped every identifier being moved to `src/lib/`/the hook against the untouched JSX
  tail to confirm nothing was left importing a since-removed local declaration.
- Full-project `tsc --noEmit` was attempted with a raised `--max-old-space-size` (per the known local
  OOM issue — see `project_tsc_cannot_complete_locally` in memory); see the follow-up note below for
  its result.

## Explicitly not done

- **No visual/JSX changes at all.** Every className, layout, and markup line is identical to before —
  that's Gemini's pass, next.
- **Did not touch the trailing standalone components** in the same file (`StatCard`,
  `GmailConnectionStatus`, `GmailReconnectAuditPanel`, `DedupAuditPanel`, `DebugPollDialog`,
  `SmsSetupGuide`, `ReconnectGmailDialog`, `FixChannelDialog`, CSV/PDF export functions) — they were
  already separate, reasonably-scoped functions and weren't part of what made the main component huge.
- **Did not fix the `(supabase.from('x') as any)` casts** throughout — pre-existing schema-type drift,
  out of scope for a pure relocation.
- **Did not convert to TanStack Query** even though newer hooks in this repo use it — the original
  code's manual `useState`/`useEffect` + realtime-subscription pattern was preserved exactly to keep
  this a behavior-neutral move, not a rewrite.
- **Not committed.** Left for review before committing, per the plan agreed with Josh.
