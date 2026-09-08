# Phase 2 deployment runbook — blockers and minimum-privilege resolution

Status, corrected **2026-09-08** after a read-only live-state audit:

- **M1–M4 ARE LIVE.** `20260908120000`, `20260908120500`, `20260908130000` and
  `20260908140000` are all in force in project `wirntoujqoyjobfhyelc`. The
  "nothing applied" status this file previously carried was stale. Do **not**
  re-apply them.
- **G7 (`20260908101500`) is still NOT applied.**
  `agent_allocate_tenant_payment_internal` still contains the
  `rent_receivable_created` leg, so every agent collection still debits A3.
- **Edge Functions are still undeployed** through this path: no
  `SUPABASE_ACCESS_TOKEN`, and `build.yml` contains no Supabase reference.
- None of these versions appear in `supabase_migrations.schema_migrations` —
  they were applied directly. **The migrations table is not evidence of live
  state in either direction.** Verify against `pg_proc` /
  `information_schema` instead (see "Live-state verification" below).
- The landlord-float-bucket columns `cycles_disbursed`, `accrual_mode` and
  `cfo_float_cycles_disbursed` are **not live**, and
  `landlord_float_buckets` does not exist. Those migration files are
  repo-only in that respect.

## Live-state verification (run this first, always)

```sql
-- expect 6 (all present today)
SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN (
  'recognise_funding_treasury','assert_funding_treasury_recognised',
  'record_rent_request_repayment_v2','treasury_waterfall_go_live',
  'treasury_waterfall_go_live_at','is_treasury_waterfall_scope');

-- both must be 2026-09-08 00:00:00+00 and identical
SELECT public.rent_pricing_floor_effective_from(), public.treasury_waterfall_go_live();

-- > 0 means G7 is still unapplied
SELECT position('rent_receivable_created' in prosrc)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'agent_allocate_tenant_payment_internal';

-- 0 today: the waterfall has never executed in production
SELECT count(*) FROM public.instalment_allocations;
```

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

### Minimum required authorization — recommended path

**RESOLVED — no longer required.** M1, M2, M3 and M4 are all live. The
instruction below is retained only as a record of what was originally planned;
**do not follow it**, because re-applying these files would redefine live money
functions for no benefit.

> ~~Run these three files in this exact order:
> `20260908120500_atomic_repayment_waterfall.sql`,
> `20260908130000_option_b_golive_scope.sql`,
> `20260908140000_single_golive_boundary.sql`, preceded by
> `20260908120000_funding_treasury_recognition.sql` (M1).~~

The only migration still awaiting deliberate application is
`20260908101500_g7_collection_direction_fix.sql`, which is a separate change
with its own approval and its own pre-checks (see that file's header).

### Post-apply verification

```sql
-- expect 6
SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN (
  'recognise_funding_treasury','assert_funding_treasury_recognised',
  'record_rent_request_repayment_v2','treasury_waterfall_go_live',
  'treasury_waterfall_go_live_at','is_treasury_waterfall_scope');

-- both must return 2026-09-08 00:00:00+00 and be identical
SELECT public.rent_pricing_floor_effective_from(), public.treasury_waterfall_go_live();

-- expect 688 legacy / 0 in scope
SELECT count(*) FILTER (WHERE NOT public.is_treasury_waterfall_scope(id)) AS legacy,
       count(*) FILTER (WHERE public.is_treasury_waterfall_scope(id))     AS in_scope
FROM rent_requests
WHERE funded_at IS NOT NULL AND total_repayment > COALESCE(amount_repaid,0)
  AND status IN ('funded','disbursed','approved','repaying');

-- must be unchanged: 455914 / 0 / -940292
SELECT (SELECT count(*) FROM general_ledger)          AS gl_rows,
       (SELECT count(*) FROM instalment_allocations)  AS alloc_rows;
```

### Status

**CLOSED.** M1–M4 are live; the verification block above passes. The remaining
database work is G7 only, which requires its own approval and maintainer action
and must not be self-authorised.

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

## Deployment order once both blockers clear

1. Re-apply M1, then M2 → M3 → M4, verifying after each
2. Run the verification block above
3. Trigger the workflow for **`fund-agent-landlord-float`** only
4. Verify against the live ledger
5. **Gate 1** — approve the canary
6. Trigger the workflow for **`tenant-pay-rent`**
7. Execute one canary; reconcile
8. **Gate 2** — approve any broader rollout

G7 remains a separate change with its own approval and is not part of this
sequence.
