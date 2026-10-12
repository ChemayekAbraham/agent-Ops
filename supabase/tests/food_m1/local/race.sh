#!/usr/bin/env bash
# Two genuinely independent sessions racing food_place_order. Session 1 places
# its order and HOLDS its transaction open; session 2 starts while session 1
# still holds its locks. Proves the advisory cap lock and the menu-row lock
# under real contention, as the authenticated role. Local clusters only.
# psql on Windows switches to the console code page when it believes it is on a
# terminal (the NUL device counts), which mis-decodes UTF-8 migration files.
export PGCLIENTENCODING=UTF8
set -euo pipefail
case "${PGHOST:-}" in 127.0.0.1|localhost) ;; *) echo "refusing: PGHOST must be local" >&2; exit 2;; esac
# live-system protection: nothing may redirect psql away from PGHOST, and the
# production project is refused outright
[ -z "${PGHOSTADDR:-}${PGSERVICE:-}${DATABASE_URL:-}" ] || { echo "refusing: PGHOSTADDR/PGSERVICE/DATABASE_URL set" >&2; exit 2; }
case "${PGHOST:-} ${PGDATABASE:-} ${PGUSER:-}" in *wirntoujqoyjobfhyelc*) echo "refusing: production project" >&2; exit 2;; esac
here="$(cd "$(dirname "$0")" && pwd)"; root="$here/../../../.."
db="food_race_$$"
P() { psql -X -v ON_ERROR_STOP=1 -q "$@"; }
P -d postgres -c "create database $db" >/dev/null
trap 'P -d postgres -c "drop database if exists $db with (force)" >/dev/null' EXIT
P -d "$db" -f "$here/00_supabase_scaffold.sql" >/dev/null
for m in "$root"/supabase/migrations/2026100912*food*.sql "$root"/supabase/migrations/2026100913*food*.sql \
         "$root"/supabase/migrations/2026100916*food*.sql "$root"/supabase/migrations/2026100917*food*.sql \
         "$root"/supabase/migrations/202610121*food*.sql; do
  P -d "$db" -1 -f "$m" >/dev/null
done
P -d "$db" -f "$here/30_race_setup.sql" >/dev/null

A=f0000000-0000-4000-8000-0000000000a1; B=f0000000-0000-4000-8000-0000000000b1
# session(user, menu_item, key, hold_seconds) -> prints OK or the SQLSTATE
session() {
  psql -X -q -At -d "$db" -v ON_ERROR_STOP=1 2>&1 <<SQL | grep -E '^(OK|ERROR)' | head -1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SET LOCAL lock_timeout = '10s';
\set VERBOSITY sqlstate
SELECT 'OK ' || (public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id','$2','quantity',$5)), '$3', 'cash')->>'order_reference');
SELECT pg_sleep($4);
COMMIT;
SQL
}

result=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (got: $2, expected: $3)"; result=1; fi; }

# ── RACE-CAP: one employee, two carts, no shared meal. Cap 2; each asks 2. ──
s1=$(mktemp); s2=$(mktemp)
session $A f0000000-0000-4000-8000-00000000ed01 cap-1 2 2 >"$s1" &
sleep 0.5
session $A f0000000-0000-4000-8000-00000000ed02 cap-2 0 2 >"$s2" &
wait
r1=$(cut -c1-2 "$s1"); r2=$(cat "$s2")
check "RACE-CAP-1 first cart accepted" "$r1" "OK"
check "RACE-CAP-2 second cart refused with 22023 after waiting" "$r2" "ERROR:  22023"
held=$(P -At -d "$db" -c "select coalesce(sum(oi.quantity),0) from food_orders o join food_order_items oi on oi.order_id=o.id where o.employee_id='$A' and o.period_id='f0000000-0000-4000-8000-00000000ef01'")
check "RACE-CAP-3 total held never exceeds the cap" "$held" "2"

# ── RACE-STOCK: two employees, one serving left. ──
session $A f0000000-0000-4000-8000-00000000ed03 stock-a 2 1 >"$s1" &
sleep 0.5
session $B f0000000-0000-4000-8000-00000000ed03 stock-b 0 1 >"$s2" &
wait
r1=$(cut -c1-2 "$s1"); r2=$(cat "$s2")
check "RACE-STOCK-1 first employee gets the last serving" "$r1" "OK"
check "RACE-STOCK-2 second employee refused with 22023, not oversold" "$r2" "ERROR:  22023"
res=$(P -At -d "$db" -c "select servings_reserved||'/'||servings_total from food_menu_items where id='f0000000-0000-4000-8000-00000000ed03'")
check "RACE-STOCK-3 reserved equals stock, never above" "$res" "1/1"
orders=$(P -At -d "$db" -c "select count(*) from food_orders where period_id='f0000000-0000-4000-8000-00000000ef02'")
check "RACE-STOCK-4 exactly one order exists" "$orders" "1"
rm -f "$s1" "$s2"
exit $result
