#!/usr/bin/env bash
# Full rehearsal: rebuild migration, fresh clone copy, run every suite. Prints FAIL lines and the totals.
set -euo pipefail
export PGCLIENTENCODING=UTF8
D="$(cd "$(dirname "$0")" && pwd)"; P="C:/Program Files/PostgreSQL/18/bin/psql.exe"
bash "$D/rebuild.sh" ssd_t
for f in test_flow.sql test_houses.sql test_staff_list.sql; do "$P" -h localhost -p 55432 -U postgres -d ssd_t -X -At -f "$D/$f" >/dev/null 2>&1 || true; done
"$P" -h localhost -p 55432 -U postgres -d ssd_t -X -At -c "select id || ' FAIL ' || title || ' :: ' || coalesce(detail,'') from tt.result where not ok order by id" -c "select 'passed ' || count(*) filter (where ok) || ' / ' || count(*) from tt.result"
