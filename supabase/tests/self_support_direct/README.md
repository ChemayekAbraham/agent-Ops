# Merchant-direct self-support: rehearsal kit

Migration `migrations/20261117120000_self_support_merchant_direct.sql` and its rollback are GENERATED:

    node build.cjs 20261117120000

- `template_new.sql`: new objects (tables, `_ssd_*` functions, triggers, cron, RPCs).
- `live/*.def.sql`: production definitions (2026-11-12) of the 19 functions the migration patches.
  `build.cjs` applies each patch at one exact anchor and writes a guard into the migration that
  refuses to run if any of those bodies changed on production since (md5, line endings ignored).
- Edit the template / patch list, never the generated files.

## Production-schema clone (structure only, no rows)
`clone/`: `q_*.sql` export the public schema (tables, types, functions, views, triggers) and a few
config tables (switches, treasury controls, ledger map) as JSON via `supabase db query --read-only -o json`;
`build_clone.cjs` + `run_clone.sql` rebuild it in a local Postgres (db `prodclone`, port 55432) with a
retry loop for dependency order; `preamble.sql` stubs auth / net / pgmq / vault / cron / storage.
`net.http_post` and `pgmq.send` record calls instead of making them. PGCLIENTENCODING must be UTF8.

## Run
    bash rebuild.sh      # migration onto a fresh copy of prodclone -> db ssd_t (harness loaded)
    bash run_all.sh      # test_flow.sql (19 scenarios) + test_houses.sql (4) -> "passed 23 / 23"... see output
    bash race.sh         # 5 races x ROUNDS, real concurrent sessions
