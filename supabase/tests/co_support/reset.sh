#!/usr/bin/env bash
# Rebuild the throwaway local co-support test DB (port 55432) and apply the migration.
set -euo pipefail
S="C:/Users/USER/AppData/Local/Temp/claude/687f05eb529ad92c/a1fdda05-4906-4282-adaf-8aee51ff8509/scratchpad/cosup"
PSQL="C:/Program Files/PostgreSQL/18/bin/psql.exe"
MIG="C:/Users/USER/Documents/projects/lovable/welilereceipts-com-98bba33b/.claude/worktrees/selftopup/supabase/migrations/20261115090000_co_support_phase1.sql"
node "$S/build.js" 20261115090000_co_support_phase1.sql >/dev/null
node "$S/build_base.js" >/dev/null
"$PSQL" -h localhost -p 55432 -U postgres -d postgres -X -q -At -c "DROP DATABASE IF EXISTS cosup_test WITH (FORCE)" -c "CREATE DATABASE cosup_test" 2>&1 | grep -v NOTICE || true
"$PSQL" -h localhost -p 55432 -U postgres -d cosup_test -X -q -v ON_ERROR_STOP=1 -f "$S/base.sql" >/dev/null
[ "${NOMIG:-0}" = 1 ] && exit 0
"$PSQL" -h localhost -p 55432 -U postgres -d cosup_test -X -q -v ON_ERROR_STOP=1 -1 -f "$MIG" 2>&1 | grep -v NOTICE || true
"$PSQL" -h localhost -p 55432 -U postgres -d cosup_test -X -q -At -c "select 'migration applied: ' || count(*) || ' co_support functions' from pg_proc where proname like '%co_support%'"
