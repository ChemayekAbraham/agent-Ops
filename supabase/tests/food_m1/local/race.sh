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
case "${PGHOST:-} ${PGDATABASE:-} ${PGUSER:-}" in *wirntoujqoyjobfhyelc*|*byrzshwlentqvktcksem*) echo "refusing: production project" >&2; exit 2;; esac
here="$(cd "$(dirname "$0")" && pwd)"; root="$here/../../../.."
db="food_race_$$"
P() { psql -X -v ON_ERROR_STOP=1 -q "$@"; }
P -d postgres -c "create database $db" >/dev/null
trap 'P -d postgres -c "drop database if exists $db with (force)" >/dev/null' EXIT
P -d "$db" -f "$here/00_supabase_scaffold.sql" >/dev/null
P -d "$db" -f "$here/07_storage_bucket.sql" >/dev/null
# shared ledger stand-in BEFORE the Food migrations (as in production)
P -d "$db" -f "$here/05_ledger_standin.sql" >/dev/null
for m in "$root"/supabase/migrations/2026100912*food*.sql "$root"/supabase/migrations/2026100913*food*.sql \
         "$root"/supabase/migrations/2026100916*food*.sql "$root"/supabase/migrations/2026100917*food*.sql \
         "$root"/supabase/migrations/202610121*food*.sql "$root"/supabase/migrations/202610131*food*.sql; do
  P -d "$db" -1 -f "$m" >/dev/null
done
# Install seats nobody (Option 2); appoint the synthetic stand-in the supported way.
P -d "$db" -c "set role service_role; select food_bootstrap_coordinator('29a0cfa8-1eaf-453c-874c-0fc72fa4f74b','Test appointment of synthetic stand-in')" >/dev/null
P -d "$db" -f "$here/30_race_setup.sql" >/dev/null
# The shared recipient gate, loaded verbatim from drizzle/migrations/0045 (only
# welile_transfer_items and check_transfer_recipient_eligibility; the schedule
# function in that file needs tables the scaffold does not have).
sed -n '/^CREATE OR REPLACE FUNCTION public.welile_transfer_items/,/^GRANT EXECUTE ON FUNCTION public.check_transfer_recipient_eligibility/p'   "$root"/drizzle/migrations/0045_transfer_recipient_eligibility.sql | P -d "$db" >/dev/null
# the standard sender reversal (drizzle 0451/0453, verbatim) for RACE-REC
sed -n '/^CREATE OR REPLACE FUNCTION public.wallet_transfer_reversal_status/,/^\$function\$;/p' \
  "$root"/drizzle/migrations/0453_wallet_transfer_reversal_status_reversed_at.sql | P -d "$db" >/dev/null
sed -n '/^CREATE OR REPLACE FUNCTION public.reverse_wallet_transfer/,/^\$\$;/p' \
  "$root"/drizzle/migrations/0451_wallet_transfer_reversal_atomic_and_notify.sql | P -d "$db" >/dev/null

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
# ── RACE-EXC: the coordinator resolves the same exception from two sessions. ──
C=29a0cfa8-1eaf-453c-874c-0fc72fa4f74b
X=$(P -At -d "$db" -c "insert into food_exceptions (kind, detail) values ('OTHER', '{\"note\":\"race\"}') returning id" | head -1)
resolve() {
  psql -X -q -At -d "$db" -v ON_ERROR_STOP=1 2>&1 <<SQL | grep -E '^(OK|ERROR)' | head -1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$C","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SET LOCAL lock_timeout = '10s';
\set VERBOSITY sqlstate
SELECT 'OK ' || (public.food_resolve_exception('$X', '$1')->>'resolved_by');
SELECT pg_sleep($2);
COMMIT;
SQL
}
resolve "first resolution reason" 2 >"$s1" &
sleep 0.5
resolve "second resolution reason" 0 >"$s2" &
wait
r1=$(cut -c1-2 "$s1"); r2=$(cat "$s2")
check "RACE-EXC-1 first resolution accepted" "$r1" "OK"
check "RACE-EXC-2 the concurrent second resolution is refused with 22023 after waiting" "$r2" "ERROR:  22023"
kept=$(P -At -d "$db" -c "select resolution_reason||'/'||(select count(*) from food_audit where entity='exception' and entity_id='$X' and action='resolved') from food_exceptions where id='$X'")
check "RACE-EXC-3 the first reason is kept and audited exactly once" "$kept" "first resolution reason/1"
# ── RACE-PAY: the employee pays the same received order from two sessions. ──
C=29a0cfa8-1eaf-453c-874c-0fc72fa4f74b
P -d "$db" -c "insert into wallets_physical (user_id) values ('$B'), ('$C') on conflict do nothing" >/dev/null
P -d "$db" -c "insert into ledger_test.opening values ('$B', 100000) on conflict do nothing" >/dev/null
ORD=$(psql -X -q -At -d "$db" -v ON_ERROR_STOP=1 <<SQL | grep -E '^[0-9a-f-]{36}$' | tail -1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$B","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE ro AS SELECT (public.food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id','f0000000-0000-4000-8000-00000000ed02','quantity',1)),'race-pay-1','wallet')->>'order_id')::uuid AS id;
SELECT set_config('request.jwt.claims', '{"sub":"$C","role":"authenticated"}', true);
SELECT public.food_set_fulfilment((SELECT id FROM ro), 'preparing');
SELECT public.food_set_fulfilment((SELECT id FROM ro), 'ready');
SELECT public.food_set_fulfilment((SELECT id FROM ro), 'delivered');
SELECT set_config('request.jwt.claims', '{"sub":"$B","role":"authenticated"}', true);
SELECT public.food_confirm_receipt((SELECT id FROM ro));
SELECT id FROM ro;
COMMIT;
SQL
)
pay() {
  psql -X -q -At -d "$db" -v ON_ERROR_STOP=1 2>&1 <<SQL | grep -E '^(OK|ERROR)' | head -1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"$B","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SET LOCAL lock_timeout = '10s';
\set VERBOSITY sqlstate
SELECT 'OK ' || (r->>'status') || ' replayed=' || (r->>'replayed') FROM (SELECT public.food_pay_order('$ORD') AS r) x;
SELECT pg_sleep($1);
COMMIT;
SQL
}
pay 2 >"$s1" &
sleep 0.5
pay 0 >"$s2" &
wait
check "RACE-PAY-0 a received order was prepared for the race" "$([ -n "$ORD" ] && echo yes)" "yes"
check "RACE-PAY-1 the first session pays (not a replay)" "$(cat "$s1")" "OK paid replayed=false"
check "RACE-PAY-2 the second session waits, then gets the same payment back" "$(cat "$s2")" "OK paid replayed=true"
legs=$(P -At -d "$db" -c "select count(*)||'/'||count(distinct transaction_group_id) from general_ledger where source_id='$ORD'")
check "RACE-PAY-3 exactly one posting: two legs, one transaction" "$legs" "2/1"
# ── RACE-REC: a reversal exists (posted here through the standard mechanism with
# the REV-D1 guard briefly off, standing in for any route); two reconcilers run at once.
P -d "$db" >/dev/null <<SQL
BEGIN;
ALTER TABLE public.general_ledger DISABLE TRIGGER food_guard_payment_reversal;
SELECT set_config('request.jwt.claims', '{"sub":"$B","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT public.reverse_wallet_transfer((SELECT 'FOODPAY-' || order_reference FROM public.food_orders WHERE id = '$ORD'));
RESET ROLE;
ALTER TABLE public.general_ledger ENABLE TRIGGER food_guard_payment_reversal;
COMMIT;
SQL
rec() {
  psql -X -q -At -d "$db" -v ON_ERROR_STOP=1 2>&1 <<SQL | grep -E '^(OK|ERROR)' | head -1
BEGIN;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SET LOCAL ROLE service_role;
SET LOCAL lock_timeout = '10s';
\set VERBOSITY sqlstate
SELECT 'OK ' || (r->>'reversed') FROM (SELECT public.food_reconcile_payments(10) AS r) x;
SELECT pg_sleep($1);
COMMIT;
SQL
}
rec 2 >"$s1" &
sleep 0.5
rec 0 >"$s2" &
wait
both="$(cat "$s1") / $(cat "$s2")"
check "RACE-REC-1 exactly one concurrent reconciler marks the reversal" "$both" "OK 1 / OK 0"
n=$(P -At -d "$db" -c "select count(*) from food_order_events where order_id='$ORD' and event_type='payment_reversed'")
check "RACE-REC-2 the reversal is recorded once" "$n" "1"
st=$(P -At -d "$db" -c "select payment_status || '/' || (select count(*) from general_ledger where source_id='$ORD') from food_orders where id='$ORD'")
check "RACE-REC-3 order reversed; reconcilers posted nothing" "$st" "payment_reversed/2"
rm -f "$s1" "$s2"
exit $result
