# Phase 2 deployment runbook — blockers and minimum-privilege resolution

Status: **M1–M4 are LIVE (verified 2026-09-08 via direct query, not via
`schema_migrations` — none of the four appear there, so the migrations table
is not evidence of state in either direction). G7 is now also LIVE (applied
2026-09-08 after all three of its required pre-checks passed — see
`20260908101500_g7_collection_direction_fix.sql`). Edge Function deployment
remains fully blocked (Blocker 2, unchanged) — that is the only remaining
item in this file.

---

## Blocker 1 — permission classifier on M2–M4

### Exact blocker

Applying `20260908120500_atomic_repayment_waterfall.sql` through the MCP
`query_database` tool was denied by the Claude Code auto-mode permission
classifier.

The classifier is **content-sensitive, not tool-blanket**. Through the same tool
in the same session it permitted: the Phase 1 foundation, the Phase 2 waterfall,
BD-3, BD-4, M1, and a `DROP FUNCTION`. It denied exactly two things:

| Denied | What it does |
|---|---|
| `20260908101500` (G7) | Rewrites a **live** money function via dynamic `EXECUTE` |
| `20260908120500` (M2) | Creates a function that **wraps** the live `record_rent_request_repayment` and the GL-posting waterfall |

Both denials are correct in intent: each touches a live money-movement path.

### Why a permission rule is the WRONG fix

Claude Code permission rules for MCP tools take the form
`mcp__<server>__<tool>`. **They match on tool name only — there is no
argument- or content-level matching for MCP tools** (unlike `Bash`, which
supports command prefixes such as `Bash(git add *)`).

So the only rule that would unblock M2 is one allowing the entire
`query_database` tool. That would authorise **every** database operation
— including destructive ones — for the whole session. That is precisely the
"bypass the classifier globally" outcome that is out of scope, and it would also
silently re-authorise the G7 change, which is a separate approval.

**There is no narrower rule available. Minimum privilege therefore means no rule
at all.**

### Minimum required authorization — recommended path (HISTORICAL — already done)

This section originally recommended a maintainer apply M1–M4 by hand. **That has
since happened** — verified live 2026-09-08 (see below). Left here for the
record of what the correct minimum-privilege path was; not an outstanding task.

1. `supabase/migrations/20260908120500_atomic_repayment_waterfall.sql` (M2)
2. `supabase/migrations/20260908130000_option_b_golive_scope.sql` (M3)
3. `supabase/migrations/20260908140000_single_golive_boundary.sql` (M4)

`20260908120000_funding_treasury_recognition.sql` (M1) was re-applied first, per
the original note.

### Live-state verification (run 2026-09-08)

```sql
SELECT
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN (
     'recognise_funding_treasury','assert_funding_treasury_recognised',
     'record_rent_request_repayment_v2','treasury_waterfall_go_live',
     'treasury_waterfall_go_live_at','is_treasury_waterfall_scope')) AS fn_count,
  (SELECT count(*) FILTER (WHERE NOT public.is_treasury_waterfall_scope(id)) FROM rent_requests
   WHERE funded_at IS NOT NULL AND total_repayment > COALESCE(amount_repaid,0)
     AND status IN ('funded','disbursed','approved','repaying')) AS legacy_count,
  (SELECT count(*) FILTER (WHERE public.is_treasury_waterfall_scope(id)) FROM rent_requests
   WHERE funded_at IS NOT NULL AND total_repayment > COALESCE(amount_repaid,0)
     AND status IN ('funded','disbursed','approved','repaying')) AS in_scope_count,
  (SELECT count(*) FROM general_ledger) AS gl_rows,
  (SELECT count(*) FROM instalment_allocations) AS alloc_rows;
```

Result at time of writing: `fn_count=6`, `legacy_count=687`, `in_scope_count=0`,
`gl_rows=456395`, `alloc_rows=0`. `rent_pricing_floor_effective_from()` and
`treasury_waterfall_go_live()` both return `2026-09-08 00:00:00+00`, confirmed
identical. `alloc_rows=0` means the waterfall is live but **dormant** — nothing
has actually posted through `post_instalment_waterfall` yet; the only caller of
`record_rent_request_repayment_v2` is `supabase/functions/tenant-pay-rent/index.ts`,
whose deployed state cannot be verified from here (see Blocker 2).

### Status

**M1–M4 done.** No further maintainer action needed for this blocker. G7
(below the fold in this doc, "G7 remains a separate change") is the one
still-open, separately-approved item from this family.

---

## Blocker 2 — Edge Function deployment

### Current mechanism

**None.** There is no deployment path of any kind.

| Channel | State |
|---|---|
| `SUPABASE_ACCESS_TOKEN` env var | not set |
| Supabase CLI | unauthenticated (`LegacyPlatformAuthRequiredError`) |
| `~/.supabase` | only `telemetry.json` and `traces` — no credentials |
| CI | `build.yml` only; **zero** supabase references anywhere in `.github/` |
| Lovable `deploy_project` | publishes the **frontend** only |

### Missing configuration

Exactly one thing: a **GitHub repository secret** named `SUPABASE_ACCESS_TOKEN`
on `weliletenants-sys/welilereceipts-com-98bba33b`.

**Minimum Supabase permission:** a personal access token whose only required
capability is deploying Edge Functions to project `wirntoujqoyjobfhyelc`. It does
**not** need database, storage, auth-admin, or billing scope. Prefer a token
owned by a service/CI identity rather than a person, and rotate it after go-live.

The project ref is **not** a secret — it is already committed in
`supabase/config.toml`.

### Blast radius — the reason this workflow is shaped the way it is

The repository contains **333 Edge Functions**. A bare
`supabase functions deploy` with no argument deploys **all of them**. Repository
state is already known to diverge from deployed state — `approve-deposit` ran
defective code for roughly a day while the revert sat in git. A bulk deploy would
push 332 unrelated, unreviewed functions to production in a single action.

`.github/workflows/deploy-edge-function.yml` is therefore built to make that
impossible:

* **no `push` or `pull_request` trigger** — `workflow_dispatch` only
* **one function per run**, from a fixed two-item `choice` list (not a free-text
  input, so it cannot be pointed at an arbitrary function)
* a typed `DEPLOY` confirmation
* a pre-flight check that the target is still absent from `config.toml`, so the
  default `verify_jwt = true` is preserved
* an explicit failure if the secret is unset

It also does **not** touch `build.yml`, which is unrelated (it builds the
frontend on `main`; the working branch is `lovable`, so adding a deploy step
there would not even fire).

### Does it affect unrelated functions or branches?

**No.** Manual trigger only, single named function, no branch automation,
`build.yml` untouched.

### Status

**Workflow prepared and committed-ready. Never run.** It becomes usable the
moment the `SUPABASE_ACCESS_TOKEN` secret is added — and even then it deploys
nothing until a maintainer triggers it by hand.

---

## Deployment order once remaining blockers clear

1. ~~Re-apply M1, then M2 → M3 → M4, verifying after each~~ — **done**
2. ~~Run the verification block above~~ — **done, see above**
3. Trigger the workflow for **`fund-agent-landlord-float`** only
4. Verify against the live ledger
5. **Gate 1** — approve the canary
6. Trigger the workflow for **`tenant-pay-rent`**
7. Execute one canary; reconcile
8. **Gate 2** — approve any broader rollout

Steps 3–8 remain blocked on Blocker 2 (`SUPABASE_ACCESS_TOKEN` still absent).
G7 remains a separate change with its own approval and is not part of this
sequence.
