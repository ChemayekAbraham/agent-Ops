# GEMINI.md

Instructions for Gemini working in this repo. Read [`README.md`](./README.md) and [`SYSTEM_CONTEXT.md`](./SYSTEM_CONTEXT.md) first — SYSTEM_CONTEXT.md is the canonical architecture reference (data model, ledger internals, subsystem inventory) and takes precedence over this file for anything about *how the system works*. This file is about *how to work on it*.

## Division of labor: Gemini does UI, Claude does logic

This project is being built by two agents in parallel. Stay in your lane so work doesn't collide:

- **Gemini (you) owns UI**: JSX markup, layout, `src/components/` visual composition, `src/pages/` presentation, Tailwind classes, shadcn/ui usage, responsive/theme behavior, animations, copy placement.
- **Claude owns logic and correctness**: `supabase/functions/` (edge functions), `supabase/migrations/`, database RPCs/triggers, `src/lib/` (calculation engines, ledger math, PDF/report generation), `src/hooks/` (data fetching, mutations, auth/session state), `src/integrations/` (Supabase client, generated types), `scripts/` (build guards), and anything that touches money, wallets, the ledger, or business rules.
- **Shared files** (a page or component that has both data logic and markup): touch only JSX structure, styling, and layout — leave data-fetching, state, handlers, and calculations alone. Don't rewire props, hooks, or business logic just because you're in the file for a visual change.
- If a task is really about data correctness, calculations, money movement, or database/API behavior, say so and hand it back rather than doing it — it's Claude's job, and doing it yourself risks introducing ledger/wallet bugs that are expensive to unwind.

## Hard rules

- **Never write ledger/wallet state directly from the frontend.** All money movement goes through SECURITY DEFINER RPCs or edge functions that already exist — call them, don't reimplement them. This is enforced at build time by `scripts/guard-frontend-ledger-writes.mjs`; don't work around it.
- **Regulatory terminology is mandatory in user-facing copy**: "Rent Plan" (never "loan"), "Supporter" (never "lender"), "Returns" (never "ROI" or "interest").
- `.env` is hands-off — never read, edit, or print its contents.
- Don't invent new data shapes or endpoints — if a component needs data that no existing hook/RPC provides, flag it for Claude rather than fetching it ad hoc from inside a component.
- **The Lovable MCP `query_database` tool is read-only for you.** It runs raw SQL against the live production database (project `43e6c2e1-18a6-4503-badb-5bb6c23491cc`) with full permissions — RLS does not apply and writes are permanent. Use it for `SELECT` only. Never run `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, or DDL (`CREATE`/`ALTER`/`DROP`), and never call an RPC that moves money through it. Any data fix or ledger/wallet change goes through the existing SECURITY DEFINER RPCs or edge functions — hand it to Claude.
- **`supabase/migrations/` does not match the live schema.** When you need to know a table or column shape, check it with a `SELECT` against `information_schema` rather than trusting a migration file.

## Design conventions

- Styling system is Tailwind CSS + shadcn/ui (Radix primitives) — see `tailwind.config.ts` for design tokens, `components.json` for shadcn config.
- Match the platform's existing visual language before introducing new patterns; check nearby components/pages for precedent first.
- Respect dark/light theme support and mobile-first responsive layout — this is a PWA optimized for low-bandwidth mobile use.

## Commands

- `npm run dev` — start dev server (Vite)
- `npm run lint` — ESLint
- `npm run build` — guarded production build (runs guards, builds, verifies dist) — run this to confirm a UI change doesn't break the build
- `npm run test:e2e` — Playwright e2e tests (`e2e/`) — check these still pass after layout/flow changes

## Git

- Confirm the target remote before pushing — don't assume `origin`.
- Prefer new commits over amending; never force-push without explicit confirmation.
