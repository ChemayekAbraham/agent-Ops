#!/usr/bin/env bash
# Phase 2 (per-person Partner Returns: every creation path uses the rule) test suite against a
# THROWAWAY local Postgres on port 55432. Never point this at production: race_stub.sql drops and
# recreates the public, auth and cron schemas (race_stub_phase2.sql also net and extensions).
#
#   bash run_phase2_tests.sh              # functional + race + timing + rollback + the Phase 1 suite again
#   bash run_phase2_tests.sh functional   # load + functional only
#   bash run_phase2_tests.sh race|timing|rollback|phase1
#
# Load = both stubs, Phase 1 applied twice, Phase 2 applied twice (phase2_between_applies.sql runs between
# the two Phase 2 applies), then (functional only) a third Phase 2 apply inside a rolled-back transaction
# to see which locks a re-apply takes. Phase 2 does not set release_ready (the release migration, Phase 7,
# does): the tests that switch on set it first, which stands in for that release.
#
# Environment: PGBIN (default "C:/Program Files/PostgreSQL/18/bin"), PGPORT (55432),
#              PGDATA_DIR (optional: initdb + start a cluster there if nothing listens on PGPORT),
#              MIG1 / MIG2 (migration files; default: the ones in supabase/migrations).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PGBIN="${PGBIN:-C:/Program Files/PostgreSQL/18/bin}"
PORT="${PGPORT:-55432}"
PSQL="$PGBIN/psql"; [ -x "$PSQL.exe" ] && PSQL="$PSQL.exe"
MIG1="${MIG1:-$DIR/../../migrations/20261108160000_partner_return_policy_phase1.sql}"
MIG2="${MIG2:-$DIR/../../migrations/20261108161000_partner_return_policy_phase2.sql}"
# Phase 6 F6: the migrations and rollbacks carry UTF-8 text (an em dash in a restored production function); psql on
# Windows otherwise talks WIN1252. The rollback suites also run one rollback with WIN1252 on purpose.
export PGCLIENTENCODING="${PGCLIENTENCODING:-UTF8}"
export PSQL PORT MIG1 MIG2
P() { "$PSQL" -h localhost -p "$PORT" -U postgres -d postgres -X -q "$@"; }
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }
WHAT="${1:-all}"

if ! "$PGBIN/pg_isready" -h localhost -p "$PORT" -q; then
  [ -n "${PGDATA_DIR:-}" ] || { echo "Nothing listens on $PORT and PGDATA_DIR is not set"; exit 2; }
  [ -f "$PGDATA_DIR/PG_VERSION" ] || "$PGBIN/initdb" -D "$PGDATA_DIR" -U postgres --auth=trust -E UTF8 --no-locale >/dev/null
  "$PGBIN/pg_ctl" -D "$PGDATA_DIR" -o "-p $PORT" -l "$PGDATA_DIR/server.log" -w start >/dev/null
fi

apply() { # $1 = file, $2 = label
  if P -v ON_ERROR_STOP=1 -1 -f "$1" >/dev/null 2>"$DIR/out_mig.err"; then echo "PASS  $(basename "$1") apply $2 (single transaction, ON_ERROR_STOP)";
  else echo "FAIL  $(basename "$1") apply $2: $(grep -m1 ERROR "$DIR/out_mig.err")"; exit 1; fi
}
load() { # $1 = full (functional: also the re-apply lock check)
  for f in race_stub.sql race_stub_phase2.sql; do
    P -v ON_ERROR_STOP=1 -1 -f "$DIR/$f" 2>&1 | grep -vE "NOTICE|DETAIL|drop cascades|already a member|other objects"
    [ "${PIPESTATUS[0]}" = 0 ] || { echo "FAIL  $f did not load"; exit 1; }
  done
  # What exists before the build (to list the build's new functions) and the production fingerprint file.
  P -v ON_ERROR_STOP=1 -c "CREATE TABLE public._t_fn_before AS SELECT DISTINCT p.proname::text AS proname FROM pg_proc p
                           JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'" >/dev/null
  { printf 'CREATE TABLE public._t_manifest AS SELECT $m$'; tr -d '\r' < "$DIR/prod_function_manifest.json"; printf '$m$::jsonb AS doc;\n'; } \
    | P -v ON_ERROR_STOP=1 >/dev/null || { echo "FAIL  manifest did not load"; exit 1; }
  apply "$MIG1" "#1"; apply "$MIG1" "#2"
  apply "$MIG2" "#1"
  P -v ON_ERROR_STOP=1 -At -f "$DIR/phase2_between_applies.sql" 2>&1 | tr -d '\r' | grep -q 'set up' \
    || { echo "FAIL  phase2_between_applies.sql"; exit 1; }
  apply "$MIG2" "#2 (after a supporter change with the stamp trigger off)"
  P -v ON_ERROR_STOP=1 -c "CREATE TABLE public._t_fn_after AS SELECT DISTINCT p.proname::text AS proname FROM pg_proc p
                           JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'" >/dev/null
  if [ "${1:-}" = full ]; then
    local locks
    locks=$({ echo "BEGIN;"; echo "\\i '$(winpath "$MIG2")'";
              echo "SELECT 'LOCKS ' || string_agg(DISTINCT c.relname || '=' || l.mode, ',' ORDER BY c.relname || '=' || l.mode)
                      FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
                     WHERE l.pid = pg_backend_pid() AND l.granted AND c.relname IN ('promissory_notes', 'rent_requests');";
              echo "ROLLBACK;"; } | P -v ON_ERROR_STOP=1 -At 2>&1 | tr -d '\r' | grep -E '^LOCKS|ERROR')
    if echo "$locks" | grep -q '^LOCKS' && ! echo "$locks" | grep -q 'AccessExclusiveLock'; then
      echo "PASS  Phase 2 re-apply (#3, rolled back) holds no ACCESS EXCLUSIVE on promissory_notes / rent_requests  [${locks#LOCKS }]"
    else echo "FAIL  Phase 2 re-apply lock check: $locks"; fi
  fi
  rm -f "$DIR/out_mig.err"
}

if [ "$WHAT" = all ] || [ "$WHAT" = functional ]; then
  load full
  echo "== Phase 2 functional tests"
  # MIG2 is passed so the backfill re-apply test (section R) applies the same Phase 2 file the load used; MIG1 (round 6) so
  # the Phase 1 re-apply test (W, d) applies the same Phase 1 file.
  ( cd "$DIR" && P -v MIG1="$(winpath "$MIG1")" -v MIG2="$(winpath "$MIG2")" -f "$DIR/phase2_test.sql" >"$DIR/out_phase2.txt" 2>"$DIR/out_phase2.err" )
  grep -E '^(PASS|FAIL|INFO|SUMMARY)' "$DIR/out_phase2.txt"
  if grep -q ERROR "$DIR/out_phase2.err"; then echo "UNEXPECTED ERRORS:"; grep -B1 -A3 ERROR "$DIR/out_phase2.err"; fi
fi

if [ "$WHAT" = all ] || [ "$WHAT" = race ]; then
  echo "== Phase 2 race tests"
  load >/dev/null
  bash "$DIR/race_run_phase2.sh" | tee "$DIR/out_race_phase2.txt"
fi

if [ "$WHAT" = all ] || [ "$WHAT" = timing ]; then
  echo "== Phase 2 timing"
  load >/dev/null
  bash "$DIR/phase2_timing.sh" | tee "$DIR/out_timing_phase2.txt"
fi

if [ "$WHAT" = all ] || [ "$WHAT" = rollback ]; then
  echo "== Rollback tests (Phase 1 rollback; Phase 2 then Phase 1)"
  bash "$DIR/rollback_test.sh" | tee "$DIR/out_rollback.txt"
fi

if [ "$WHAT" = all ] || [ "$WHAT" = phase1 ]; then
  echo "== Phase 1 suite again (persona + race + timing)"
  bash "$DIR/run_phase1_tests.sh" | tee "$DIR/out_phase1_all.txt" | grep -E '^(FAIL|SUMMARY|UNEXPECTED|== |TIMING|RACE|PASS  migration)|passed|failed'
fi
