#!/usr/bin/env bash
# Rebuild migration, apply to a fresh copy of the production-schema clone (db ssd_base), copy to $1 (default ssd_t).
set -euo pipefail
export PGCLIENTENCODING=UTF8
D="$(cd "$(dirname "$0")" && pwd)"; P="C:/Program Files/PostgreSQL/18/bin/psql.exe"; DB="${1:-ssd_t}"
node "$D/build.cjs" 20261117120000 >/dev/null
"$P" -h localhost -p 55432 -U postgres -d postgres -X -q -c "DROP DATABASE IF EXISTS ssd_base WITH (FORCE)" -c "CREATE DATABASE ssd_base TEMPLATE prodclone" 2>&1 | grep -v NOTICE || true
"$P" -h localhost -p 55432 -U postgres -d ssd_base -X -q -v ON_ERROR_STOP=1 -1 -f "$D/../../migrations/20261117120000_self_support_merchant_direct.sql" >/dev/null
"$P" -h localhost -p 55432 -U postgres -d ssd_base -X -q -v ON_ERROR_STOP=1 -1 -f "$D/../../migrations/20261117130000_self_support_staff_payments_list.sql" >/dev/null
"$P" -h localhost -p 55432 -U postgres -d ssd_base -X -q -v ON_ERROR_STOP=1 -f "$D/harness.sql" >/dev/null
"$P" -h localhost -p 55432 -U postgres -d postgres -X -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB TEMPLATE ssd_base" 2>&1 | grep -v NOTICE || true
