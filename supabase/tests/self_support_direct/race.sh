#!/usr/bin/env bash
# Concurrency races on the production-schema clone (run after run_all.sh; uses db ssd_t).
# Each round: committed setup, then two real sessions overlapping (pg_sleep holds one open), then invariants.
set -uo pipefail
export PGCLIENTENCODING=UTF8
P="C:/Program Files/PostgreSQL/18/bin/psql.exe"; DB="${DB:-ssd_t}"; ROUNDS="${ROUNDS:-5}"
q() { "$P" -h localhost -p 55432 -U postgres -d "$DB" -X -At -q -c "$1" 2>&1; }
pass=0; fail=0
check() { if [ "$1" = "t" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL $2 :: $1"; fi; }

q "UPDATE pipeline_switches SET is_on = true WHERE key = 'self_support_merchant_direct'" >/dev/null

for i in $(seq 1 "$ROUNDS"); do
  # R1: two partners support the same plan at the same moment
  read -r A B RR <<<"$(q "SELECT a, b, rr FROM (SELECT tt.person('RaceA', ARRAY['supporter']) a, tt.person('RaceB', ARRAY['supporter']) b, tt.plan(400000) rr) x" | tr '|' ' ')"
  q "SELECT tt.float('$A', 1000000), tt.float('$B', 1000000)" >/dev/null
  ( q "BEGIN; SELECT tt.as_user('$A'); SELECT funder_support_tenant_direct(ARRAY['$RR'::uuid]); SELECT pg_sleep(1.2); COMMIT;" >/dev/null ) &
  ( sleep 0.3; q "BEGIN; SELECT tt.as_user('$B'); SELECT funder_support_tenant_direct(ARRAY['$RR'::uuid]); COMMIT;" >/dev/null ) &
  wait
  check "$(q "SELECT (SELECT count(*) FROM self_support_landlord_payments WHERE rent_request_id = '$RR') = 1
              AND (SELECT count(*) FROM landlord_payouts WHERE rent_request_id = '$RR') = 1
              AND (tt.avail('$A') = 1000000) <> (tt.avail('$B') = 1000000)")" "R1.$i double support: one payment, one partner debited"

  # R2: merchant pays (held open) while the 48h expiry runs on the same expired payment
  read -r A RR <<<"$(q "SELECT a, rr FROM (SELECT tt.person('RaceP', ARRAY['supporter']) a, tt.plan(300000) rr) x" | tr '|' ' ')"
  q "SELECT tt.float('$A', 1000000); SELECT tt.as_user('$A'); SELECT funder_support_tenant_direct(ARRAY['$RR'::uuid]); SELECT tt.as_user(NULL);
     UPDATE self_support_landlord_payments SET expires_at = now() - interval '1 minute' WHERE rent_request_id = '$RR';" >/dev/null
  ( q "BEGIN; SELECT tt.merchant_pays('$RR'); SELECT pg_sleep(1.2); COMMIT;" >/dev/null ) &
  ( sleep 0.3; q "SELECT ssd_expire_unpaid();" >/dev/null ) &
  wait
  check "$(q "SELECT s.status = 'paid' AND w.status = 'completed' AND tt.avail('$A') = 1000000 - 306000
              FROM self_support_landlord_payments s JOIN withdrawal_requests w ON w.id = s.withdrawal_request_id WHERE s.rent_request_id = '$RR'")" "R2.$i pay first: paid, not refunded"

  # R3: the 48h expiry (held open) while the merchant tries to pay
  read -r A RR <<<"$(q "SELECT a, rr FROM (SELECT tt.person('RaceE', ARRAY['supporter']) a, tt.plan(300000) rr) x" | tr '|' ' ')"
  q "SELECT tt.float('$A', 1000000); SELECT tt.as_user('$A'); SELECT funder_support_tenant_direct(ARRAY['$RR'::uuid]); SELECT tt.as_user(NULL);
     UPDATE self_support_landlord_payments SET expires_at = now() - interval '1 minute' WHERE rent_request_id = '$RR';" >/dev/null
  ( q "BEGIN; SELECT ssd_expire_unpaid(); SELECT pg_sleep(1.2); COMMIT;" >/dev/null ) &
  ( sleep 0.3; q "SELECT tt.merchant_pays('$RR');" >/dev/null ) &
  wait
  check "$(q "SELECT s.status = 'refunded' AND w.status = 'cancelled' AND tt.avail('$A') = 1000000
              FROM self_support_landlord_payments s JOIN withdrawal_requests w ON w.id = s.withdrawal_request_id WHERE s.rent_request_id = '$RR'")" "R3.$i expiry first: refunded, merchant cannot settle"

  # R4: two merchants settle the same payout at once
  read -r A RR <<<"$(q "SELECT a, rr FROM (SELECT tt.person('RaceD', ARRAY['supporter']) a, tt.plan(300000) rr) x" | tr '|' ' ')"
  q "SELECT tt.float('$A', 1000000); SELECT tt.as_user('$A'); SELECT funder_support_tenant_direct(ARRAY['$RR'::uuid]); SELECT tt.as_user(NULL);" >/dev/null
  ( q "BEGIN; SELECT tt.merchant_pays('$RR'); SELECT pg_sleep(1.0); COMMIT;" >/dev/null ) &
  ( sleep 0.3; q "SELECT tt.merchant_pays('$RR');" >/dev/null ) &
  wait
  check "$(q "SELECT s.status = 'paid'
              AND (SELECT count(*) FROM self_support_notices n WHERE n.ref_id = s.id AND n.event = 'paid') = 3
              AND (SELECT count(*) FROM general_ledger g WHERE g.idempotency_key LIKE 'psm-float-%'
                     AND g.source_id = ANY (s.line_ids)) = 2
              FROM self_support_landlord_payments s WHERE s.rent_request_id = '$RR'")" "R4.$i double settle: activated once"

  # R5: reject (payout failed) held open while a merchant settles
  read -r A RR <<<"$(q "SELECT a, rr FROM (SELECT tt.person('RaceR', ARRAY['supporter']) a, tt.plan(300000) rr) x" | tr '|' ' ')"
  q "SELECT tt.float('$A', 1000000); SELECT tt.as_user('$A'); SELECT funder_support_tenant_direct(ARRAY['$RR'::uuid]); SELECT tt.as_user(NULL);" >/dev/null
  ( q "BEGIN; UPDATE landlord_payouts SET status = 'failed', last_error = 'Merchant rejected: race' WHERE id = (tt.payment('$RR')).landlord_payout_id; SELECT pg_sleep(1.2); COMMIT;" >/dev/null ) &
  ( sleep 0.3; q "SELECT tt.merchant_pays('$RR');" >/dev/null ) &
  wait
  # never both: partner refunded AND the landlord paid
  check "$(q "SELECT NOT (s.status = 'refunded' AND w.status IN ('completed','processing'))
              AND ((s.status = 'refunded' AND tt.avail('$A') = 1000000) OR (s.status <> 'refunded' AND tt.avail('$A') = 1000000 - 306000))
              FROM self_support_landlord_payments s JOIN withdrawal_requests w ON w.id = s.withdrawal_request_id WHERE s.rent_request_id = '$RR'")" "R5.$i reject vs settle: never refunded and paid"
done
echo "races: passed $pass, failed $fail"
