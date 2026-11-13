#!/usr/bin/env bash
# Author: SSENKAALI PIUS
# Email: ssenkaali.pius@welileapp.com
# Date: 2026-11-13
# Website: welileapp.com
#
# Option 2, Phase 2 on a local copy of the prod schema (template dp_prodclone, port 55432):
#   phase 1 + phase 2 (twice) -> fixture -> tests -> races (on a copy) -> phase 2 rollback (twice, originals
#   compared byte for byte) -> phase 2 again.
set -euo pipefail
export PGCLIENTENCODING=UTF8
D="$(cd "$(dirname "$0")" && pwd)"; R="$D/../.."
P="${PSQL:-C:/Program Files/PostgreSQL/18/bin/psql.exe}"; TPL="${TPL:-dp_prodclone}"; DB="${DB:-dp_p2}"
M1="$R/migrations/20261121090000_direct_pay_phase1_tables.sql"
M2="$R/migrations/20261121100000_direct_pay_phase2_claim_submit.sql"
RB2="$R/rollbacks/20261121100000_direct_pay_phase2_claim_submit.rollback.sql"
run() { "$P" -h localhost -p 55432 -U postgres -d "$DB" -X -q -v ON_ERROR_STOP=1 -c "SET client_min_messages = warning" -1 -f "$1" >/dev/null; }
sig() { "$P" -h localhost -p 55432 -U postgres -d "$DB" -X -At -c "select md5(pg_get_viewdef('public.v_partner_self_fundable_plans'::regclass, true)) || ' ' || (select string_agg(md5(prosrc), ' ' order by proname) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('psm_plan_partner_reserved_stage', 'psm_reserved_plan_ids', 'funder_pending_hold'))"; }

"$P" -h localhost -p 55432 -U postgres -d postgres -X -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB TEMPLATE $TPL" 2>&1 | grep -v NOTICE || true
run "$M1"
before=$(sig)
run "$M2"; echo "phase 2: applied"
run "$M2"; echo "phase 2: applied again (re-runnable)"
"$P" -h localhost -p 55432 -U postgres -d "$DB" -X -q -f "$D/phase2_fixture.sql" >/dev/null; echo "fixture: loaded"
"$P" -h localhost -p 55432 -U postgres -d "$DB" -X -q -f "$D/phase2_test.sql" | grep -E "FAIL|passed" || true
SRC="$DB" DB="${DB}_race" bash "$D/race_phase2.sh" | grep -E "FAIL|races passed"
run "$RB2"; echo "phase 2 rollback: applied"
run "$RB2"; echo "phase 2 rollback: applied again (re-runnable)"
after=$(sig)
left=$("$P" -h localhost -p 55432 -U postgres -d "$DB" -X -At -c "select count(*) from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'direct_pay%' or proname like '_direct_pay%' or proname = 'trg_direct_pay_plan_guard')")
echo "rollback: originals identical: $([ "$before" = "$after" ] && echo yes || echo "NO ($before / $after)"); phase-2 functions left: $left (want 0)"
run "$M2"; echo "phase 2: applied after rollback"
