#!/usr/bin/env bash
# Rebuild the local production-schema clone (db prodclone on :55432). Structure only.
set -euo pipefail
export PGCLIENTENCODING=UTF8
D="$(cd "$(dirname "$0")" && pwd)"; P="C:/Program Files/PostgreSQL/18/bin/psql.exe"; DB="${DB:-prodclone}"
node "$D/build_clone.cjs" >/dev/null
"$P" -h localhost -p 55432 -U postgres -d postgres -X -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB" 2>&1 | grep -v NOTICE || true
"$P" -h localhost -p 55432 -U postgres -d $DB -X -q -v ON_ERROR_STOP=1 -f "$D/preamble.sql"
"$P" -h localhost -p 55432 -U postgres -d $DB -X -q -v ON_ERROR_STOP=1 -f "$D/stmts.sql"
"$P" -h localhost -p 55432 -U postgres -d $DB -X -q -v ON_ERROR_STOP=1 -f "$D/run_clone.sql" 2>&1 | grep -v WARNING || true
node "$D/build_seed.cjs" >/dev/null; [ -f "$D/seed.sql" ] && "$P" -h localhost -p 55432 -U postgres -d $DB -X -q -v ON_ERROR_STOP=1 -f "$D/seed.sql"
"$P" -h localhost -p 55432 -U postgres -d $DB -X -At -c "select 'clone failures: ' || count(*) from _clone_stmts where not done"
