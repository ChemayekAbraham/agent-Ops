#!/usr/bin/env bash
# Ledger posting boundary (20261013126000) on a DISPOSABLE local database.
# Same guards as the Food runners: local PGHOST only, no production reference.
export PGCLIENTENCODING=UTF8
set -euo pipefail
case "${PGHOST:-}" in 127.0.0.1|localhost) ;; *) echo "refusing: PGHOST must be local" >&2; exit 2;; esac
[ -z "${PGHOSTADDR:-}${PGSERVICE:-}${DATABASE_URL:-}" ] || { echo "refusing: PGHOSTADDR/PGSERVICE/DATABASE_URL set" >&2; exit 2; }
case "${PGHOST:-} ${PGDATABASE:-} ${PGUSER:-}" in *wirntoujqoyjobfhyelc*) echo "refusing: production project" >&2; exit 2;; esac
here="$(cd "$(dirname "$0")" && pwd)"; root="$here/../../../.."
db="ledger_boundary_$$"
P() { psql -X -v ON_ERROR_STOP=1 -q "$@"; }
P -d postgres -c "create database $db" >/dev/null
trap 'P -d postgres -c "drop database if exists $db with (force)" >/dev/null' EXIT
P -d "$db" -f "$root/supabase/tests/food_m1/local/00_supabase_scaffold.sql" >/dev/null
for v in coo cto super_admin; do P -d "$db" -c "ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS '$v'" >/dev/null; done
P -d "$db" -f "$here/05_standins.sql" >/dev/null
before=$(psql -X -tAq -d "$db" -c "select has_function_privilege('authenticated','public.create_ledger_transaction(jsonb,text,boolean)','EXECUTE')")
echo "BEFORE: authenticated may execute create_ledger_transaction = $before (reproduces the exposure)"
P -d "$db" -1 -f "$root/supabase/migrations/20261013126000_ledger_direct_execute_boundary.sql" 2>&1 | grep -E "NOTICE|ERROR" || true
# Release step between part 1 and part 2: the boundary exists, nothing is revoked
# yet, so the LIVE COO page (direct calls) keeps working until the new one ships.
mid=$(psql -X -tAq -d "$db" -c "select has_function_privilege('authenticated','public.create_ledger_transaction(jsonb,text,boolean)','EXECUTE')::text || '/' || (to_regprocedure('public.post_portfolio_roi_ledger(text,uuid,numeric,text,text,text)') is not null)::text")
echo "MID (after 126000 only): old direct path still open / boundary exists = $mid"
P -d "$db" -1 -f "$root/supabase/migrations/20261013129000_ledger_direct_execute_revoke.sql" 2>&1 | grep -E "NOTICE|ERROR" || true
out="$(P -d "$db" -f "$here/10_boundary.sql" 2>&1 || true)"
echo "$out" | grep -E 'NOTICE:  (PASS|FAIL)|(^|: )ERROR:  ' | sed -E 's/^(psql:[^ ]* )?NOTICE:  //' | sort -V
pass=$(echo "$out" | grep -c 'NOTICE:  PASS' || true); fail=$(echo "$out" | grep -c -E 'NOTICE:  FAIL|(^|: )ERROR:  ' || true)
[ "$before" = "t" ] || { echo "FAIL precondition: exposure not reproduced"; fail=$((fail+1)); }
if [ "$mid" = "true/true" ]; then echo "PASS A-32 after part 1 only, the live page's direct path still works and the boundary exists"; pass=$((pass+1));
else echo "FAIL A-32 mid-release state (got $mid)"; fail=$((fail+1)); fi
echo "== $pass passed, $fail failed"
[ "$fail" -eq 0 ]
