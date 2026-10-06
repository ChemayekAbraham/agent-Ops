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

### Lovable sync: don't push to `lovable` directly

Lovable follows the `lovable` branch both ways. A push there while its agent is mid-edit makes Lovable replace its sandbox and park the agent's work on a `lovable-sync-<unix-time>` branch ("A push to your repository replaced your Lovable work"). Lovable has no setting to pause sync or to pull before it commits, so the protection is workflow:

- **Work on a feature branch**, e.g. `dev/<topic>`, cut from the latest `origin/lovable`. Commit there freely. Branches other than `lovable` are invisible to Lovable.
- **Merge into `lovable` only when Lovable's agent is idle.** Check `get_project` → `agentFinished` (and recent `lovable-sync-*` branches) first. If the agent is running, wait; don't merge "just this once".
- **Before merging:** `git fetch origin`, merge `origin/lovable` into your branch (no rebase), resolve conflicts there, run `npm run guard:all`, then fast-forward `lovable` to it. Confirm the target remote and get Josh's go-ahead before the push to `lovable`.
- **Never rebase, amend, or force-push `lovable`.** Rebases flatten merge commits and rewrite the base Lovable started from. Use merge commits or fast-forwards only.
- **After the push**, message Lovable (see the notify-after-push rule) so it re-syncs on purpose.
- **Sweeping side branches:** when a `lovable-sync-*` branch appears, diff it with `git diff origin/lovable...origin/lovable-sync-<ts>`, merge only what `lovable` lacks, and delete it once merged or knowingly dropped. Don't delete without Josh's say-so.
