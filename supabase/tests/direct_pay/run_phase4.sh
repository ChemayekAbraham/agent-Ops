#!/usr/bin/env bash
# Author: SSENKAALI PIUS
# Email: ssenkaali.pius@welileapp.com
# Date: 2026-11-13
# Website: welileapp.com
#
# Option 2, Phase 4 on a local copy of the prod schema (template dp_prodclone, port 55432):
#   phases 1-3 -> phase 4 (twice) -> fixture -> phase 2, 3 and 4 tests -> phase 3 races (on a copy) ->
#   phase 4 rollback (twice, notice-queue checks compared) -> phase 4 again.
set -euo pipefail
export PGCLIENTENCODING=UTF8
D="$(cd "$(dirname "$0")" && pwd)"; R="$D/../.."
P="${PSQL:-C:/Program Files/PostgreSQL/18/bin/psql.exe}"; TPL="${TPL:-dp_prodclone}"; DB="${DB:-dp_p4}"
M="$R/migrations"
RB4="$R/rollbacks/20261121120000_direct_pay_phase4_messages_timers.rollback.sql"
run() { "$P" -h localhost -p 55432 -U postgres -d "$DB" -X -q -v ON_ERROR_STOP=1 -c "SET client_min_messages = warning" -1 -f "$1" >/dev/null; }
sig() { "$P" -h localhost -p 55432 -U postgres -d "$DB" -X -At -c "select md5(string_agg(conname || pg_get_constraintdef(oid), ',' order by conname)) from pg_constraint where conrelid = 'public.self_support_notices'::regclass"; }

"$P" -h localhost -p 55432 -U postgres -d postgres -X -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB TEMPLATE $TPL" 2>&1 | grep -v NOTICE || true
run "$M/20261121090000_direct_pay_phase1_tables.sql"; run "$M/20261121100000_direct_pay_phase2_claim_submit.sql"
run "$M/20261121110000_direct_pay_phase3_ops_approval.sql"
before=$(sig)
run "$M/20261121120000_direct_pay_phase4_messages_timers.sql"; echo "phase 4: applied"
run "$M/20261121120000_direct_pay_phase4_messages_timers.sql"; echo "phase 4: applied again (re-runnable)"
"$P" -h localhost -p 55432 -U postgres -d "$DB" -X -q -f "$D/phase2_fixture.sql" >/dev/null; echo "fixture: loaded"
for t in 2 3 4; do
  "$P" -h localhost -p 55432 -U postgres -d "$DB" -X -q -f "$D/phase${t}_test.sql" | grep -E "FAIL|passed" | sed "s/^/phase $t tests: /" || true
done
SRC="$DB" DB="${DB}_race" bash "$D/race_phase3.sh" | grep -E "FAIL|races passed" | sed 's/^/phase 3 /'
run "$RB4"; echo "phase 4 rollback: applied"
run "$RB4"; echo "phase 4 rollback: applied again (re-runnable)"
after=$(sig)
left=$("$P" -h localhost -p 55432 -U postgres -d "$DB" -X -At -c "select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('direct_pay_tick','direct_pay_send_reminders','_direct_pay_notify','trg_direct_pay_messages')")
echo "rollback: notice-queue checks identical: $([ "$before" = "$after" ] && echo yes || echo NO); phase-4 functions left: $left (want 0)"
run "$M/20261121120000_direct_pay_phase4_messages_timers.sql"; echo "phase 4: applied after rollback"
