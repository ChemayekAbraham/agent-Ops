#!/usr/bin/env bash
# Author: SSENKAALI PIUS
# Email: ssenkaali.pius@welileapp.com
# Date: 2026-11-13
# Website: welileapp.com
#
# Option 2, every local check in one go (port 55432, template dp_prodclone): phase 1 runner (migration and rollback
# on its own copy), then phases 1-8 applied twice, fixture, every SQL test, every race, and the phase 7 rollback.
set -euo pipefail
export PGCLIENTENCODING=UTF8
D="$(cd "$(dirname "$0")" && pwd)"; R="$D/../.."
P="${PSQL:-C:/Program Files/PostgreSQL/18/bin/psql.exe}"; TPL="${TPL:-dp_prodclone}"; DB="${DB:-dp_p7}"
run() { "$P" -h localhost -p 55432 -U postgres -d "$DB" -X -q -v ON_ERROR_STOP=1 -c "SET client_min_messages = warning" -1 -f "$1" >/dev/null; }

bash "$D/run_phase1.sh" | grep -E "passed|leaves" | sed 's/^/phase 1: /'
"$P" -h localhost -p 55432 -U postgres -d postgres -X -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB TEMPLATE $TPL" 2>&1 | grep -v NOTICE || true
for pass in 1 2; do
  for m in "$R"/migrations/202611210900*_direct_pay_*.sql "$R"/migrations/2026112110*_direct_pay_*.sql \
           "$R"/migrations/2026112111*_direct_pay_*.sql "$R"/migrations/2026112112*_direct_pay_*.sql \
           "$R"/migrations/2026112113*_direct_pay_*.sql "$R"/migrations/2026112114*_direct_pay_*.sql \
           "$R"/migrations/2026112115*_direct_pay_*.sql; do run "$m"; done
done
echo "phases 1-8: applied twice"
"$P" -h localhost -p 55432 -U postgres -d "$DB" -X -q -f "$D/phase2_fixture.sql" >/dev/null
for t in 2 3 4 5 7 8; do
  "$P" -h localhost -p 55432 -U postgres -d "$DB" -X -q -f "$D/phase${t}_test.sql" | grep -E "FAIL|passed" | sed "s/^/phase $t tests: /" || true
done
for r in 2 3 7; do
  SRC="$DB" DB="${DB}_race$r" bash "$D/race_phase$r.sh" | grep -E "FAIL|races passed" | sed "s/^/phase $r /"
done
run "$R/rollbacks/20261121140000_direct_pay_phase7_health.rollback.sql"; run "$R/rollbacks/20261121140000_direct_pay_phase7_health.rollback.sql"
echo "phase 7 rollback: twice, left: $("$P" -h localhost -p 55432 -U postgres -d "$DB" -X -At -c "select count(*) from pg_proc where proname like '%direct_pay_health%'") (want 0)"
run "$R/migrations/20261121140000_direct_pay_phase7_health.sql"; echo "phase 7: applied again"
"$P" -h localhost -p 55432 -U postgres -d "$DB" -X -q -c "UPDATE pipeline_switches SET is_on = false WHERE key = 'self_support_direct_pay'"
run "$R/rollbacks/20261121150000_direct_pay_phase8_pilot.rollback.sql"; run "$R/rollbacks/20261121150000_direct_pay_phase8_pilot.rollback.sql"
echo "phase 8 rollback: twice, pilot table left: $("$P" -h localhost -p 55432 -U postgres -d "$DB" -X -At -c "select count(*) from pg_class where relname = 'direct_pay_pilot_partners'") (want 0)"
run "$R/migrations/20261121150000_direct_pay_phase8_pilot.sql"; echo "phase 8: applied again"
