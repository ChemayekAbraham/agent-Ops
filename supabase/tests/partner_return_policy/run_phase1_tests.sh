#!/usr/bin/env bash
# Phase 1 (per-person Partner Returns) test suite against a THROWAWAY local Postgres on port 55432.
# Never point this at production: race_stub.sql drops and recreates the public, auth and cron schemas.
#
#   bash run_phase1_tests.sh            # stub + migration x2 + persona tests + race tests + timing
#   bash run_phase1_tests.sh persona    # stub + migration x2 + persona tests only
#
# Environment: PGBIN (default "C:/Program Files/PostgreSQL/18/bin"), PGPORT (55432),
#              PGDATA_DIR (optional: initdb + start a cluster there if nothing listens on PGPORT).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PGBIN="${PGBIN:-C:/Program Files/PostgreSQL/18/bin}"
PORT="${PGPORT:-55432}"
PSQL="$PGBIN/psql"; [ -x "$PSQL.exe" ] && PSQL="$PSQL.exe"
MIG="${MIG:-$DIR/../../migrations/20261105150000_partner_return_policy_phase1.sql}"
# Phase 6 F6: the migrations and rollbacks carry UTF-8 text (an em dash in a restored production function); psql on
# Windows otherwise talks WIN1252. The rollback suites also run one rollback with WIN1252 on purpose.
export PGCLIENTENCODING="${PGCLIENTENCODING:-UTF8}"
export PSQL PORT
P() { "$PSQL" -h localhost -p "$PORT" -U postgres -d postgres -X -q "$@"; }

if ! "$PGBIN/pg_isready" -h localhost -p "$PORT" -q; then
  [ -n "${PGDATA_DIR:-}" ] || { echo "Nothing listens on $PORT and PGDATA_DIR is not set"; exit 2; }
  [ -f "$PGDATA_DIR/PG_VERSION" ] || "$PGBIN/initdb" -D "$PGDATA_DIR" -U postgres --auth=trust -E UTF8 --no-locale >/dev/null
  "$PGBIN/pg_ctl" -D "$PGDATA_DIR" -o "-p $PORT" -l "$PGDATA_DIR/server.log" -w start >/dev/null
fi

load() { # stub, then the migration twice (second run proves it is re-runnable)
  P -v ON_ERROR_STOP=1 -1 -f "$DIR/race_stub.sql" 2>&1 | grep -vE "NOTICE|DETAIL|drop cascades"
  [ "${PIPESTATUS[0]}" = 0 ] || { echo "FAIL  stub did not load"; exit 1; }
  for i in 1 2; do
    if P -v ON_ERROR_STOP=1 -1 -f "$MIG" >/dev/null 2>"$DIR/out_mig$i.err"; then echo "PASS  migration apply #$i (single transaction, ON_ERROR_STOP)";
    else echo "FAIL  migration apply #$i: $(grep -m1 ERROR "$DIR/out_mig$i.err")"; exit 1; fi
    rm -f "$DIR/out_mig$i.err"
  done
  # The release (Phase 7) sets release_ready; the tests turn the switch on, so mark it ready here (owner session, guard off: no audit/email).
  P -X -q -c "ALTER TABLE public.partner_return_policy DISABLE TRIGGER trg_partner_return_policy_guard; UPDATE public.partner_return_policy SET release_ready = true; ALTER TABLE public.partner_return_policy ENABLE TRIGGER trg_partner_return_policy_guard;" >/dev/null
}

load
echo "== persona tests"
P -f "$DIR/phase1_persona_test.sql" >"$DIR/out_persona.txt" 2>"$DIR/out_persona.err"
grep -E '^(PASS|FAIL|INFO|SUMMARY)' "$DIR/out_persona.txt"
if grep -q ERROR "$DIR/out_persona.err"; then echo "UNEXPECTED ERRORS:"; grep -B1 -A2 ERROR "$DIR/out_persona.err"; fi
[ "${1:-all}" = persona ] && exit 0

echo "== race tests"
load >/dev/null
bash "$DIR/race_run.sh"

echo "== timing"
load >/dev/null
bash "$DIR/phase1_timing.sh"
