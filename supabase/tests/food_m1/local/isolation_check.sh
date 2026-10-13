#!/usr/bin/env bash
# Live-system protection check, on a LOCAL disposable cluster:
#   1. plant financial canaries (50_financial_canaries.sql);
#   2. fingerprint every non-Food object;
#   3. apply the five Food migrations;
#   4. drive the whole Food lifecycle as real users — every payment mode,
#      kitchen to delivery, cancellations, exceptions, handover, bootstrap;
#   5. prove: the non-Food fingerprint is identical, the canary tables saw zero
#      DML, balances are unchanged, and food_pay_order still refuses.
export PGCLIENTENCODING=UTF8
set -uo pipefail
case "${PGHOST:-}" in 127.0.0.1|localhost) ;; *) echo "refusing: PGHOST must be local" >&2; exit 2;; esac
[ -z "${PGHOSTADDR:-}${PGSERVICE:-}${DATABASE_URL:-}" ] || { echo "refusing: PGHOSTADDR/PGSERVICE/DATABASE_URL set" >&2; exit 2; }
case "${PGHOST:-} ${PGDATABASE:-} ${PGUSER:-}" in *wirntoujqoyjobfhyelc*) echo "refusing: production project" >&2; exit 2;; esac
here="$(cd "$(dirname "$0")" && pwd)"; root="$(cd "$here/../../../.." && pwd)"; M="$root/supabase/migrations"
db="food_iso_$$"
P() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }
Q() { psql -X -q -At -v ON_ERROR_STOP=1 "$@"; }
result=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (got: $2, expected: $3)"; result=1; fi; }
P -d postgres -c "create database $db" >/dev/null
trap 'P -d postgres -c "drop database if exists $db with (force)" >/dev/null' EXIT
P -d "$db" -f "$here/00_supabase_scaffold.sql" >/dev/null
P -d "$db" -f "$here/50_financial_canaries.sql" >/dev/null

inv() {  # fails the whole check if the inventory errors or is implausibly small
  local out; out=$(Q -d "$db" -f "$here/non_food_inventory.sql" 2>&1) || { echo "FAIL inventory query errored: $out" >&2; exit 1; }
  [ "$(echo "$out" | wc -l)" -ge 50 ] || { echo "FAIL inventory too small to be meaningful" >&2; exit 1; }
  echo "$out"; }
before=$(inv) || exit 1; gl_before=$(Q -d "$db" -c "select count(*)||':'||sum(amount) from general_ledger")
wt_before=$(Q -d "$db" -c "select count(*)||':'||sum(amount) from wallet_transactions")

for m in 20261009120000_food_service_schema_and_coordinator 20261009130000_food_service_operations_rpcs \
         20261009160000_food_coordinator_candidates 20261009170000_food_exception_resolution \
         20261012120000_food_m1_release_corrections 20261013120000_food_meal_images 20261013125000_food_staff_includes_pso; do
  P -d "$db" -1 -f "$M/$m.sql" >/dev/null || { echo "FAIL apply $m"; result=1; }
done
after=$(inv) || exit 1
if [ "$before" = "$after" ]; then echo "PASS ISO-01 every non-Food object identical after the migrations ($(echo "$before" | wc -l) objects)"
else echo "FAIL ISO-01 non-Food objects changed:"; diff <(echo "$before") <(echo "$after") | head -20; result=1; fi

# the whole lifecycle, as real users (synthetic identities)
Q -d "$db" >/dev/null 2>&1 <<'SQL'
INSERT INTO auth.users(id,email) VALUES ('f0000000-0000-4000-8000-0000000000a1','a@example.invalid'),('f0000000-0000-4000-8000-0000000000b1','b@example.invalid'),('f0000000-0000-4000-8000-0000000000e1','e@example.invalid');
INSERT INTO profiles(id,full_name,email) VALUES ('f0000000-0000-4000-8000-0000000000a1','TEST A','a@example.invalid'),('f0000000-0000-4000-8000-0000000000b1','TEST B','b@example.invalid'),('f0000000-0000-4000-8000-0000000000e1','TEST E','e@example.invalid');
INSERT INTO user_roles(user_id,role) VALUES ('f0000000-0000-4000-8000-0000000000a1','employee'),('f0000000-0000-4000-8000-0000000000b1','employee'),('f0000000-0000-4000-8000-0000000000e1','employee');
SQL
Q -d "$db" > /dev/null <<'SQL'
CREATE TEMP TABLE c(k text, v uuid); GRANT ALL ON c TO authenticated;
BEGIN; SELECT set_config('request.jwt.claims','{"sub":"29a0cfa8-1eaf-453c-874c-0fc72fa4f74b"}',true); SET LOCAL ROLE authenticated;
INSERT INTO c VALUES ('m', food_upsert_meal(NULL,'Canary meal',NULL,NULL,4000));
SELECT food_set_meal_status((SELECT v FROM c WHERE k='m'),'published');
INSERT INTO c VALUES ('p', food_upsert_service_period(NULL,'All day','00:00','23:59:59',NULL,NULL));
INSERT INTO c VALUES ('i', food_schedule_meal((now() AT TIME ZONE 'Africa/Kampala')::date,(SELECT v FROM c WHERE k='p'),(SELECT v FROM c WHERE k='m'),NULL,50,true));
COMMIT;
BEGIN; SELECT set_config('request.jwt.claims','{"sub":"f0000000-0000-4000-8000-0000000000a1"}',true); SET LOCAL ROLE authenticated;
INSERT INTO c SELECT 'o_'||m, (food_place_order(jsonb_build_array(jsonb_build_object('menu_item_id',(SELECT v FROM c WHERE k='i'),'quantity',2)),'iso-'||m, m, 'no onions')->>'order_id')::uuid
  FROM unnest(ARRAY['cash','wallet','mobile_money']) m;
SELECT food_raise_exception('QUALITY_ISSUE','cold',(SELECT v FROM c WHERE k='o_cash'));
SELECT food_cancel_my_order((SELECT v FROM c WHERE k='o_mobile_money'),'changed my mind');
COMMIT;
BEGIN; SELECT set_config('request.jwt.claims','{"sub":"29a0cfa8-1eaf-453c-874c-0fc72fa4f74b"}',true); SET LOCAL ROLE authenticated;
SELECT food_set_fulfilment((SELECT v FROM c WHERE k='o_cash'),'preparing');
SELECT food_set_fulfilment((SELECT v FROM c WHERE k='o_cash'),'ready');
SELECT food_set_fulfilment((SELECT v FROM c WHERE k='o_cash'),'delivered');
SELECT food_set_fulfilment((SELECT v FROM c WHERE k='o_wallet'),'cancelled','kitchen closed');
SELECT food_resolve_exception((SELECT id FROM food_exceptions LIMIT 1),'replaced');
SELECT food_raise_exception('STOCK_UNAVAILABLE','short of greens');
SELECT food_coordinator_overview(); SELECT * FROM food_preparation_list();
SELECT food_transfer_coordinator('f0000000-0000-4000-8000-0000000000e1','transfer_with_backup','planned canary handover');
COMMIT;
SQL
lifecycle=$?
check "ISO-02 full Food lifecycle ran (3 modes, deliver, cancel x2, exceptions, handover)" "$lifecycle" "0"
check "ISO-03 canary money tables saw zero INSERT/UPDATE/DELETE/TRUNCATE" "$(Q -d "$db" -c "select count(*) from canary.hits")" "0"
check "ISO-04 general_ledger unchanged" "$(Q -d "$db" -c "select count(*)||':'||sum(amount) from general_ledger")" "$gl_before"
check "ISO-05 wallet balance source unchanged" "$(Q -d "$db" -c "select count(*)||':'||sum(amount) from wallet_transactions")" "$wt_before"
check "ISO-06 delivered order is still unpaid, with no transaction" \
  "$(Q -d "$db" -c "select payment_status||'/'||coalesce(transaction_group_id::text,'none')||'/'||coalesce(paid_at::text,'none') from food_orders where fulfilment_status='delivered'")" "pending_payment/none/none"
check "ISO-07 no Food order is paid, whatever its mode" "$(Q -d "$db" -c "select count(*) from food_orders where payment_status<>'pending_payment' or paid_at is not null or transaction_group_id is not null")" "0"
check "ISO-08 food_pay_order still refuses (0A000)" \
  "$(Q -d "$db" -c "do \$\$ begin perform set_config('request.jwt.claims','{\"sub\":\"f0000000-0000-4000-8000-0000000000a1\"}',true); set local role authenticated; perform food_pay_order((select id from food_orders limit 1)); raise notice 'PAID'; exception when sqlstate '0A000' then raise notice 'REFUSED'; end \$\$;" 2>&1 | grep -o -E 'REFUSED|PAID')" "REFUSED"
final=$(inv) || exit 1
check "ISO-09 non-Food objects still identical after the lifecycle" "$( [ "$before" = "$final" ] && echo same || echo changed)" "same"
# positive control: the canary counter really does see a ledger write
check "ISO-10 control: a real ledger write IS counted by the canary"   "$(Q -d "$db" -c "begin; select public.create_ledger_transaction(1,'control'); select count(*) from canary.hits; rollback;" | tail -1)" "1"
exit $result
