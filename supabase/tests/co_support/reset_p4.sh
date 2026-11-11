#!/usr/bin/env bash
set -euo pipefail
bash "C:/Users/USER/AppData/Local/Temp/claude/687f05eb529ad92c/a1fdda05-4906-4282-adaf-8aee51ff8509/scratchpad/cosup/reset.sh" >/dev/null
node "C:/Users/USER/AppData/Local/Temp/claude/687f05eb529ad92c/a1fdda05-4906-4282-adaf-8aee51ff8509/scratchpad/cosup/build_p4.js" >/dev/null
"C:/Program Files/PostgreSQL/18/bin/psql.exe" -h localhost -p 55432 -U postgres -d cosup_test -X -q -v ON_ERROR_STOP=1 -1 -f "C:/Users/USER/Documents/projects/lovable/welilereceipts-com-98bba33b/.claude/worktrees/selftopup/supabase/migrations/20261115100000_co_support_phase4_houses.sql" 2>&1 | grep -v NOTICE || true
"C:/Program Files/PostgreSQL/18/bin/psql.exe" -h localhost -p 55432 -U postgres -d cosup_test -X -q -At -c "select 'phase 4 applied: ' || count(*) || ' co_support functions' from pg_proc where proname like '%co_support%'"
