#!/usr/bin/env bash
# v2 races (run after run_all.sh; db ssd_t). Real concurrent sessions; pg_sleep holds one open.
set -uo pipefail
export PGCLIENTENCODING=UTF8
P="C:/Program Files/PostgreSQL/18/bin/psql.exe"; DB="${DB:-ssd_t}"; ROUNDS="${ROUNDS:-5}"
q() { "$P" -h localhost -p 55432 -U postgres -d "$DB" -X -At -q -c "$1" 2>&1; }
pass=0; fail=0
check() { if [ "$1" = "t" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL $2 :: $1"; fi; }
q "UPDATE pipeline_switches SET is_on = true WHERE key = 'self_support_activate_on_landlord_paid'" >/dev/null
setup() {  # partner + supported plan; echoes "partner rr"
  q "SELECT a, rr FROM (SELECT tt.person('Race$1', ARRAY['supporter']) a, tt.plan(300000) rr) x" | tr '|' ' '
}
support() { q "SELECT tt.float('$1', 1000000); SELECT tt.as_user('$1'); SELECT funder_support_tenant_direct(ARRAY['$2'::uuid]); SELECT tt.as_user(NULL);" >/dev/null; }

for i in $(seq 1 "$ROUNDS"); do
  # R1: two partners support the same plan at the same moment
  read -r A B RR <<<"$(q "SELECT a, b, rr FROM (SELECT tt.person('RaceA', ARRAY['supporter']) a, tt.person('RaceB', ARRAY['supporter']) b, tt.plan(400000) rr) x" | tr '|' ' ')"
  q "SELECT tt.float('$A', 1000000), tt.float('$B', 1000000)" >/dev/null
  ( q "BEGIN; SELECT tt.as_user('$A'); SELECT funder_support_tenant_direct(ARRAY['$RR'::uuid]); SELECT pg_sleep(1.2); COMMIT;" >/dev/null ) &
  ( sleep 0.3; q "BEGIN; SELECT tt.as_user('$B'); SELECT funder_support_tenant_direct(ARRAY['$RR'::uuid]); COMMIT;" >/dev/null ) &
  wait
  check "$(q "SELECT (SELECT count(*) FROM self_support_landlord_payments WHERE rent_request_id = '$RR') = 1
              AND (SELECT count(*) FROM agent_landlord_float_allocations WHERE rent_request_id = '$RR' AND status <> 'cancelled') = 1
              AND (tt.avail('$A') = 1000000) <> (tt.avail('$B') = 1000000)")" "R1.$i double support: one plan funded once"

  # R2: 48h recall (held open) while the agent withdraws
  read -r A RR <<<"$(setup W)"; support "$A" "$RR"
  q "UPDATE self_support_landlord_payments SET expires_at = now() - interval '1 minute' WHERE rent_request_id = '$RR'" >/dev/null
  ( q "BEGIN; SELECT ssd_expire_unpaid(); SELECT pg_sleep(1.2); COMMIT;" >/dev/null ) &
  ( sleep 0.3; q "SELECT tt.agent_withdraws('$RR');" >/dev/null ) &
  wait
  check "$(q "SELECT NOT (s.status = 'refunded' AND EXISTS (SELECT 1 FROM landlord_payouts lp WHERE lp.rent_request_id = s.rent_request_id
                                                             AND lp.status NOT IN ('failed','escalated')))
              AND ((s.status = 'refunded' AND tt.avail('$A') = 1000000) OR (s.status = 'queued' AND tt.avail('$A') = 1000000 - 306000))
              FROM self_support_landlord_payments s WHERE s.rent_request_id = '$RR' ORDER BY s.created_at DESC LIMIT 1")" "R2.$i recall vs withdraw: never refunded with a live payout"

  # R3: the merchant settles (held open) while the 48h recall runs
  read -r A RR <<<"$(setup S)"; support "$A" "$RR"
  LP=$(q "SELECT tt.agent_withdraws('$RR')")
  q "UPDATE self_support_landlord_payments SET expires_at = now() - interval '1 minute' WHERE rent_request_id = '$RR'" >/dev/null
  ( q "BEGIN; SELECT tt.merchant_settles('$LP'); SELECT pg_sleep(1.2); COMMIT;" >/dev/null ) &
  ( sleep 0.3; q "SELECT ssd_expire_unpaid();" >/dev/null ) &
  wait
  check "$(q "SELECT s.status = 'paid' AND tt.avail('$A') = 1000000 - 306000 FROM self_support_landlord_payments s WHERE s.rent_request_id = '$RR'")" "R3.$i settle vs recall: paid, not refunded"

  # R4: two settle calls on the same payout
  read -r A RR <<<"$(setup D)"; support "$A" "$RR"
  LP=$(q "SELECT tt.agent_withdraws('$RR')")
  ( q "BEGIN; SELECT tt.merchant_settles('$LP'); SELECT pg_sleep(1.0); COMMIT;" >/dev/null ) &
  ( sleep 0.3; q "SELECT tt.merchant_settles('$LP');" >/dev/null ) &
  wait
  check "$(q "SELECT s.status = 'paid' AND (SELECT count(*) FROM self_support_notices n WHERE n.ref_id = s.id AND n.event = 'paid') = 2
              AND (SELECT count(*) FROM general_ledger g WHERE g.source_table = 'landlord_payouts' AND g.source_id = '$LP'
                     AND g.category = 'agent_commission_earned') = 1
              FROM self_support_landlord_payments s WHERE s.rent_request_id = '$RR'")" "R4.$i double settle: activated and paid once"
done
echo "races: passed $pass, failed $fail"
