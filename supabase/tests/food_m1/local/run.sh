#!/usr/bin/env bash
# Builds a fresh disposable database from the scaffold plus the Food migrations
# and runs the behavioural suite. Refuses anything that is not a local cluster.
#   PGHOST must be 127.0.0.1/localhost. Usage: run.sh [extra_migration.sql ...]
# psql on Windows switches to the console code page when it believes it is on a
# terminal (the NUL device counts), which mis-decodes UTF-8 migration files.
export PGCLIENTENCODING=UTF8
set -euo pipefail
case "${PGHOST:-}" in 127.0.0.1|localhost) ;; *) echo "refusing: PGHOST must be local" >&2; exit 2;; esac
# live-system protection: nothing may redirect psql away from PGHOST, and the
# production project is refused outright
[ -z "${PGHOSTADDR:-}${PGSERVICE:-}${DATABASE_URL:-}" ] || { echo "refusing: PGHOSTADDR/PGSERVICE/DATABASE_URL set" >&2; exit 2; }
case "${PGHOST:-} ${PGDATABASE:-} ${PGUSER:-}" in *wirntoujqoyjobfhyelc*) echo "refusing: production project" >&2; exit 2;; esac
here="$(cd "$(dirname "$0")" && pwd)"; root="$here/../../../.."
db="food_run_$$"
P() { psql -X -v ON_ERROR_STOP=1 -q "$@"; }
P -d postgres -c "create database $db" >/dev/null
trap 'P -d postgres -c "drop database if exists $db with (force)" >/dev/null' EXIT
P -d "$db" -f "$here/00_supabase_scaffold.sql" >/dev/null
for m in "$root"/supabase/migrations/2026100912*food*.sql "$root"/supabase/migrations/2026100913*food*.sql \
         "$root"/supabase/migrations/2026100916*food*.sql "$root"/supabase/migrations/2026100917*food*.sql \
         "$root"/supabase/migrations/202610121*food*.sql "$@"; do
  [ -e "$m" ] || continue
  P -d "$db" -1 -f "$m" >/dev/null && echo "applied $(basename "$m")"
done
# One session for all suites: later files reuse 10_behaviour.sql's helpers.
# 20_* only applies once the release-corrections migration is present.
suites=("$here/10_behaviour.sql")
ls "$root"/supabase/migrations/20261012120000_food_m1_release_corrections.sql >/dev/null 2>&1 \
  && suites+=("$here/20_release_corrections.sql" "$here/25_canteen_access.sql" "$here/40_completion.sql")
out="$(cat "${suites[@]}" | P -d "$db" 2>&1 || true)"
# Count only real psql errors ("ERROR:  ..."), never a result value that
# happens to contain the word (e.g. the ORDER_ERROR exception kind).
echo "$out" | grep -E 'NOTICE:  (PASS|FAIL)|(^|: )ERROR:  ' | sed -E 's/^(psql:[^ ]* )?NOTICE:  //'
pass=$(echo "$out" | grep -c 'NOTICE:  PASS' || true); fail=$(echo "$out" | grep -c -E 'NOTICE:  FAIL|(^|: )ERROR:  ' || true)
echo "== $pass passed, $fail failed"
[ "$fail" -eq 0 ]
