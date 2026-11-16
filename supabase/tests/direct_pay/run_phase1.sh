#!/usr/bin/env bash
# Author: SSENKAALI PIUS
# Email: ssenkaali.pius@welileapp.com
# Date: 2026-11-13
# Website: welileapp.com
#
# Option 2, Phase 1 on a local copy of the prod schema (default template dp_prodclone, port 55432):
#   migration twice -> tests -> rollback twice -> migration again (proves the rollback leaves it re-appliable).
set -euo pipefail
export PGCLIENTENCODING=UTF8
D="$(cd "$(dirname "$0")" && pwd)"; R="$D/../.."
P="${PSQL:-C:/Program Files/PostgreSQL/18/bin/psql.exe}"; TPL="${TPL:-dp_prodclone}"; DB="${DB:-dp_p1}"
M="$R/migrations/20261121090000_direct_pay_phase1_tables.sql"
RB="$R/rollbacks/20261121090000_direct_pay_phase1_tables.rollback.sql"
run() { "$P" -h localhost -p 55432 -U postgres -d "$DB" -X -q -v ON_ERROR_STOP=1 -c "SET client_min_messages = warning" -1 -f "$1" >/dev/null; }

"$P" -h localhost -p 55432 -U postgres -d postgres -X -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB TEMPLATE $TPL" 2>&1 | grep -v NOTICE || true
before=$("$P" -h localhost -p 55432 -U postgres -d "$DB" -X -At -c "select md5(array_to_string(public.ledger_category_allowlist(), ','))")

run "$M"; echo "migration: applied"
run "$M"; echo "migration: applied again (re-runnable)"
"$P" -h localhost -p 55432 -U postgres -d "$DB" -X -q -f "$D/phase1_test.sql" | grep -E "FAIL|passed" || true
run "$RB"; echo "rollback: applied"
run "$RB"; echo "rollback: applied again (re-runnable)"
after=$("$P" -h localhost -p 55432 -U postgres -d "$DB" -X -At -c "select md5(array_to_string(public.ledger_category_allowlist(), ','))")
left=$("$P" -h localhost -p 55432 -U postgres -d "$DB" -X -At -c "select (select count(*) from information_schema.columns where table_name = 'funder_offplatform_rent_payments' and column_name = 'flow') + (select count(*) from pg_class where relname = 'funder_offplatform_rent_proofs') + (select count(*) from ledger_account_map where category = 'partner_direct_rent_capital' or (category = 'welile_cover_fee' and wallet_bucket = 'float')) + (select count(*) from pipeline_switches where key = 'self_support_direct_pay')")
allow=$("$P" -h localhost -p 55432 -U postgres -d "$DB" -X -At -c "select 'partner_direct_rent_capital' = any(ledger_category_allowlist()) or not ('welile_cover_fee' = any(ledger_category_allowlist()))")
echo "rollback leaves: $left objects (want 0); allowlist changed back: $([ "$allow" = f ] && echo yes || echo NO); allowlist categories identical to before: $([ "$before" = "$after" ] && echo yes || echo NO)"
run "$M"; echo "migration: applied after rollback"
