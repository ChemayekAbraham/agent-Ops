# Tenant Ops Workspace — build rules

We are adding a NEW dashboard tab. Nothing that exists changes behaviour.

## The parallel-source principle

Where an existing table, view or function does not give the new tab what it
needs — wrong basis, missing detail, inferred values, no weekly support — we
build OUR OWN alongside it, reading the same raw records, and leave the original
untouched and running. Classic keeps using the original. We never repair or
re-point a shared object. Two parallel readings of the same raw data is the
intended outcome, not a problem to resolve.

Raw records we READ and never write: rent_requests, agent_collections,
agent_expected_day_plans, general_ledger, wallets, cc_* tables, location tables,
user_roles, profiles.

## Absolute constraints

1. NEVER modify an existing file. The only exceptions are the two single-line
   additions in rule 11.
2. NEVER ALTER, DROP or CREATE OR REPLACE any existing database object. No
   existing table, view, function, trigger, index, policy, grant or cron job
   changes in any way.
3. NEVER create an index, constraint, trigger, policy, grant or comment ON a
   table that already exists. Indexes only on tops_* tables. If a query is slow
   because an existing table lacks an index, record it in the build log as a
   RECOMMENDATION and move on.
4. NEVER edit an existing function to add a case, branch or parameter for us —
   including notification, alerting, role and wallet functions. Call them as
   they are. If one cannot serve us unchanged, build our own additive
   equivalent under the tops_ prefix and say so in the build log.
5. NEVER add a trigger to an existing table. Derive from what is already
   recorded, by polling on our own schedule.
6. NEVER change the collection write path. agent_allocate_tenant_payment and
   everything it touches stay exactly as they are. Our tables are derived
   read-models.
7. NEVER change the calling engine. cc_* tables, their RPCs and their cron jobs
   keep their current behaviour and population logic. We read them and add
   beside them, referencing cc_ rows by id with no foreign key.
8. NEVER change Classic. Every file under src/components/executive/tenant-ops/
   is read-only, including TenantOpsHub.tsx, TenantOpsClassicShell.tsx,
   tenantOpsNav.ts and TenantOpsHome.tsx.
9. NEVER backfill, correct or clean data in an existing table, even where it is
   wrong. Quarantine it in our read-model and show it as such.
10. NEVER delete or disable an existing cron job, report or surface.
11. The ONLY permitted edits: ONE route entry in src/App.tsx and ONE nav entry
    in src/components/layout/executiveSidebarConfig.ts. Nothing else in either
    file. If a change appears to need more, STOP and ask.

## Naming

- Database: every new object is prefixed tops_.
- React: src/components/tenant-ops-workspace/**,
  src/pages/tenant-ops/workspace/**, src/hooks/tenantOpsWorkspace/**.
- Migrations and SQL tests: supabase/migrations/**, supabase/tests/**.
- Docs: docs/TOPS_*.md

## Standards (from SYSTEM_CONTEXT.md — follow exactly)

- Database changes ship as migrations only.
- Every new table, in one migration: CREATE TABLE, GRANT, ENABLE ROW LEVEL
  SECURITY, CREATE POLICY.
- Every function: SET search_path = public. SECURITY DEFINER only where needed,
  with an internal has_role(auth.uid(), ...) check. Never grant EXECUTE to anon.
- Roles come from user_roles via has_role, never from profiles.
- No money arithmetic in the browser. Every figure comes from a tops_ RPC and
  carries a basis string and an as-at time.
- Reversed collections are excluded from every figure we compute.
- The collection day is an Africa/Kampala date.
- Currency as UGX via formatUGX. Never USh, Shs or /=.
- User-facing copy uses Rent Plan, Supporter, Returns.
- Semantic Tailwind tokens only. No hardcoded colours. No emojis.
- Mobile first: Today, Collections, Calling and the tenant screen work
  one-handed at 380px.

## Kill switch

The new tab reads a feature flag from the existing config mechanism (read-only)
and renders nothing when it is off. Turning the tab off must never require a
deploy or a revert.

## Definition of done, every task

- Migration applies cleanly. New RPCs correct for a DAILY plan and a WEEKLY plan.
- npm run build passes. Every existing guard script and test still passes.
- Run: git diff --stat. If any file appears outside
  src/components/tenant-ops-workspace/**, src/pages/tenant-ops/workspace/**,
  src/hooks/tenantOpsWorkspace/**, supabase/migrations/**, supabase/tests/** or
  docs/** — other than the two lines in rule 11 — REVERT it and report why it
  seemed necessary.
- Append to docs/TOPS_BUILD_LOG.md: objects added, cron jobs added with their
  schedules, anything left unverified, and any recommendation about an existing
  object that we deliberately did not act on.
