# CLAUDE.md

Instructions for Claude Code working in this repo. Read [`README.md`](./README.md) and [`SYSTEM_CONTEXT.md`](./SYSTEM_CONTEXT.md) first — SYSTEM_CONTEXT.md is the canonical architecture reference (data model, ledger internals, subsystem inventory) and takes precedence over this file for anything about *how the system works*. This file is about *how to work on it*.

## Division of labor: Claude does logic, Gemini does UI

This project is being built by two agents in parallel. Stay in your lane so work doesn't collide:

- **Claude (you) owns logic and correctness**: `supabase/functions/` (edge functions), `supabase/migrations/`, database RPCs/triggers, `src/lib/` (calculation engines, ledger math, PDF/report generation), `src/hooks/` (data fetching, mutations, auth/session state), `src/integrations/` (Supabase client, generated types), `scripts/` (build guards), and anything that touches money, wallets, the ledger, or business rules.
- **Gemini owns UI**: JSX markup, layout, `src/components/` visual composition, `src/pages/` presentation, Tailwind classes, shadcn/ui usage, responsive/theme behavior, animations.
- **Shared files** (a page or component that has both data logic and markup): touch only the data-fetching/state/handler code, leave JSX structure and styling to Gemini. Don't reformat or restyle a file just because you're in it for a logic change.
- If a task is purely visual (spacing, colors, copy, layout), say so and hand it back rather than doing it — it's Gemini's job and doing it yourself risks fighting Gemini's next pass.

## Hard rules

- **The frontend never writes ledger/wallet state directly.** All money movement goes through SECURITY DEFINER RPCs or edge functions. This is enforced at build time by `scripts/guard-frontend-ledger-writes.mjs` — don't work around it.
- **Regulatory terminology is mandatory in user-facing copy**: "Rent Plan" (never "loan"), "Supporter" (never "lender"), "Returns" (never "ROI" or "interest"). This applies to strings you write in edge functions, emails/SMS, and any copy — not just UI.
- `.env` is hands-off — never read, edit, or print its contents.
- Run `npm run guard:all` before considering a backend/logic change done — it runs all the `guard:*` checks (persona routes, frontend ledger writes, deposit purpose, canonical tags, schema types, mcp deploy).

## Known gotchas

- **`supabase/migrations/` does not faithfully reflect the live production schema.** Verify columns/functions/RPCs against the actual production database before relying on a migration file. Branch work from `origin/lovable`, not local, if local is stale.
- For treasury cash figures, `get_treasury_cash_position` (A1+A5) is the correct RPC — `get_treasury_snapshot` is superseded and can show malformed negative numbers that look like a deficit but aren't.
- Absolute "set float to X" operations re-credit already-spent float — prefer delta/"add" operations for float adjustments unless you've confirmed the current spent amount.

## Git

- Confirm the target remote before pushing — don't assume `origin`.
- Prefer new commits over amending; never force-push without explicit confirmation.
