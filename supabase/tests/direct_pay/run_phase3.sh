#!/usr/bin/env bash
# Author: SSENKAALI PIUS
# Email: ssenkaali.pius@welileapp.com
# Date: 2026-11-13
# Website: welileapp.com
#
# Option 2, Phase 3 on a local copy of the prod schema (template dp_prodclone, port 55432):
#   phases 1-2 -> phase 3 (twice) -> fixture -> tests -> races (on a copy) -> phase 3 rollback (twice, the two
#   edited functions compared byte for byte) -> phase 3 again.
set -euo pipefail
export PGCLIENTENCODING=UTF8
D="$(cd "$(dirname "$0")" && pwd)"; R="$D/../.."
P="${PSQL:-C:/Program Files/PostgreSQL/18/bin/psql.exe}"; TPL="${TPL:-dp_prodclone}"; DB="${DB:-dp_p3}"
M1="$R/migrations/20261121090000_direct_pay_phase1_tables.sql"
M2="$R/migrations/20261121100000_direct_pay_phase2_claim_submit.sql"
M3="$R/migrations/20261121110000_direct_pay_phase3_ops_approval.sql"
RB3="$R/rollbacks/20261121110000_direct_pay_phase3_ops_approval.rollback.sql"
run() { "$P" -h localhost -p 55432 -U postgres -d "$DB" -X -q -v ON_ERROR_STOP=1 -c "SET client_min_messages = warning" -1 -f "$1" >/dev/null; }
sig() { "$P" -h localhost -p 55432 -U postgres -d "$DB" -X -At -c "select string_agg(md5(prosrc), ' ' order by proname) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('gate_repaying_on_merchant_landlord_payout', '_am_plan_clock_core')"; }

"$P" -h localhost -p 55432 -U postgres -d postgres -X -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB TEMPLATE $TPL" 2>&1 | grep -v NOTICE || true
run "$M1"; run "$M2"
before=$(sig)
run "$M3"; echo "phase 3: applied"
run "$M3"; echo "phase 3: applied again (re-runnable)"
"$P" -h localhost -p 55432 -U postgres -d "$DB" -X -q -f "$D/phase2_fixture.sql" >/dev/null; echo "fixture: loaded"
"$P" -h localhost -p 55432 -U postgres -d "$DB" -X -q -f "$D/phase2_test.sql" | grep -E "FAIL|passed" | sed 's/^/phase 2 tests with phase 3 on: /' || true
"$P" -h localhost -p 55432 -U postgres -d "$DB" -X -q -f "$D/phase3_test.sql" | grep -E "FAIL|passed" | sed 's/^/phase 3 tests: /' || true
SRC="$DB" DB="${DB}_race" bash "$D/race_phase3.sh" | grep -E "FAIL|races passed"
run "$RB3"; echo "phase 3 rollback: applied"
run "$RB3"; echo "phase 3 rollback: applied again (re-runnable)"
after=$(sig)
left=$("$P" -h localhost -p 55432 -U postgres -d "$DB" -X -At -c "select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('direct_pay_approve','direct_pay_reject','direct_pay_ops_queue','direct_pay_otp_issue','_direct_pay_cover_charge')")
echo "rollback: originals identical: $([ "$before" = "$after" ] && echo yes || echo NO); phase-3 functions left: $left (want 0)"
run "$M3"; echo "phase 3: applied after rollback"
