#!/usr/bin/env bash
# Author: SSENKAALI PIUS
# Email: ssenkaali.pius@welileapp.com
# Date: 2026-11-13
# Website: welileapp.com
#
# Option 2, Phase 7 races: real concurrent sessions on a copy of a database with phases 1-7 and phase2_fixture.sql.
#   R1 the same TID on two payments, approved by two officers at the same moment
#   R2 two SMS for one payment uploaded at the same moment
#   R3 the partner releases the hold at the same moment an SMS arrives
set -uo pipefail
export PGCLIENTENCODING=UTF8
P="${PSQL:-C:/Program Files/PostgreSQL/18/bin/psql.exe}"; SRC="${SRC:-dp_p7}"; DB="${DB:-dp_p7_race}"
GRACE=11111111-1111-4111-8111-111111111111; BRIAN=33333333-3333-4333-8333-333333333333
LUCY=66666666-6666-4666-8666-666666666666; LIZ=69696969-6969-4969-8969-696969696969
plan() { printf 'a0a0a0a0-0000-4000-8000-0000000000%02d' "$1"; }
q() { "$P" -h localhost -p 55432 -U postgres -d "$DB" -X -At -q -c "SET client_min_messages = warning" -c "$1"; }
session() { # $1 user, $2 sql, $3 sleep-before-commit
  "$P" -h localhost -p 55432 -U postgres -d "$DB" -X -At -q -c "SET client_min_messages = warning" \
    -c "BEGIN" -c "SELECT set_config('request.jwt.claim.sub', '$1', true)" -c "$2" -c "SELECT pg_sleep($3)" -c "COMMIT" 2>&1 | grep -v '^$' | head -2 | tail -1
}
"$P" -h localhost -p 55432 -U postgres -d postgres -X -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB TEMPLATE $SRC" 2>&1 | grep -v NOTICE
pass=0; total=0
check() { total=$((total+1)); if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS  $1"; else echo "FAIL  $1: got [$2] want [$3]"; fi; }

"$P" -h localhost -p 55432 -U postgres -d "$DB" -X -q -v ON_ERROR_STOP=1 <<SQL >/dev/null
SET client_min_messages = warning;
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO auth.users (id) VALUES ('$LUCY'), ('$LIZ');
INSERT INTO profiles (id, full_name, email, phone) VALUES ('$LUCY','Lucy','lucy@example.test','0700000006'), ('$LIZ','Liz','liz@example.test','0700000009');
INSERT INTO user_roles (user_id, role, enabled) VALUES ('$LUCY','landlord_ops',true), ('$LIZ','landlord_ops',true);
SET LOCAL session_replication_role = origin;
SELECT create_ledger_transaction(jsonb_build_array(
  jsonb_build_object('user_id','$BRIAN','amount',30000,'direction','cash_in','category','partner_funding','ledger_scope','wallet',
    'wallet_bucket','float','recipient_type','operational_wallet','source_table','test','description','race float'),
  jsonb_build_object('amount',30000,'direction','cash_out','category','wallet_deposit','ledger_scope','platform','source_table','test','description','race cash')), 'race7-float');
-- R1: Grace (R1) and Brian (R3) both hand in the SAME TID.
SELECT set_config('request.jwt.claim.sub', '$GRACE', true);
SELECT direct_pay_claim('$(plan 1)');
SELECT direct_pay_record_proof('$GRACE', (SELECT id FROM funder_offplatform_rent_payments WHERE rent_request_id='$(plan 1)' AND flow='direct_pay'),
  '$GRACE/r1.jpg','sha-r1','mtn',NULL,NULL,jsonb_build_object('status','read','tid','MP 9999','amount',500000,'phone','0772123456','paid_at',(now()+interval '1 minute')::text));
SELECT set_config('request.jwt.claim.sub', '$BRIAN', true);
SELECT direct_pay_claim('$(plan 3)');
SELECT direct_pay_record_proof('$BRIAN', (SELECT id FROM funder_offplatform_rent_payments WHERE rent_request_id='$(plan 3)' AND flow='direct_pay'),
  '$BRIAN/r3.jpg','sha-r3','mtn',NULL,NULL,jsonb_build_object('status','read','tid','9999','amount',500000,'phone','0772123456','paid_at',(now()+interval '1 minute')::text));
CREATE TABLE public.t_race7 AS
  SELECT p.rent_request_id, p.id AS payment_id, (public.direct_pay_otp_issue('$LUCY', p.id))->>'otp' AS otp
    FROM funder_offplatform_rent_payments p WHERE p.flow='direct_pay' AND p.status='pending';
-- R2 and R3: Grace holds R5 and R6, nothing uploaded yet.
SELECT set_config('request.jwt.claim.sub', '$GRACE', true);
SELECT direct_pay_claim('$(plan 5)'); SELECT direct_pay_claim('$(plan 6)');
COMMIT;
SQL
pay1=$(q "select payment_id from t_race7 where rent_request_id='$(plan 1)'"); otp1=$(q "select otp from t_race7 where rent_request_id='$(plan 1)'")
pay3=$(q "select payment_id from t_race7 where rent_request_id='$(plan 3)'"); otp3=$(q "select otp from t_race7 where rent_request_id='$(plan 3)'")
pay5=$(q "select id from funder_offplatform_rent_payments where rent_request_id='$(plan 5)' and flow='direct_pay'")
pay6=$(q "select id from funder_offplatform_rent_payments where rent_request_id='$(plan 6)' and flow='direct_pay'")

# R1
session $LUCY "SELECT coalesce(direct_pay_approve('$pay1','$otp1','Lucy called',  'flag checked')->>'code','ok')" 2 > /tmp/dp7_r1a & sleep 0.5
r1b=$(session $LIZ "SELECT coalesce(direct_pay_approve('$pay3','$otp3','Liz called','flag checked')->>'code','ok')" 0); wait
check "same TID: the first approval wins" "$(cat /tmp/dp7_r1a)" "ok"
check "same TID: the second is refused (tid_already_approved)" "$r1b" "tid_already_approved"
check "same TID: one approved proof, one portfolio, the second payment still pending" \
  "$(q "select (select count(*) from funder_offplatform_rent_proofs where tid_norm='9999' and status='approved') || '/' || (select count(*) from funder_offplatform_rent_payments where id in ('$pay1','$pay3') and portfolio_id is not null) || '/' || (select status from funder_offplatform_rent_payments where id='$pay3')")" "1/1/pending"

# R2
session postgres "SELECT direct_pay_record_proof('$GRACE','$pay5','$GRACE/a.jpg','sha-a','mtn',NULL,NULL,jsonb_build_object('status','read','tid','5001','amount',450000,'phone','0772123456','paid_at',(now()+interval '1 minute')::text))->>'status'" 2 > /tmp/dp7_r2a & sleep 0.5
r2b=$(session postgres "SELECT direct_pay_record_proof('$GRACE','$pay5','$GRACE/b.jpg','sha-b','mtn',NULL,NULL,jsonb_build_object('status','read','tid','5002','amount',50000,'phone','0772123456','paid_at',(now()+interval '1 minute')::text))->>'status'" 0); wait
check "two SMS at once: the first leaves it held (450,000)" "$(cat /tmp/dp7_r2a)" "held"
check "two SMS at once: the second sees both and moves it on" "$r2b" "pending"
check "two SMS at once: received 500,000, one 'proof received' message" \
  "$(q "select amount_received::int || '/' || (select count(*) from self_support_notices where ref_id='$pay5' and event='dp_proof_received' and channel='sms') from funder_offplatform_rent_payments where id='$pay5'")" "500000/1"

# R3
session $GRACE "SELECT direct_pay_release('$pay6')->>'status'" 2 > /tmp/dp7_r3a & sleep 0.5
r3b=$(session postgres "SELECT coalesce(direct_pay_record_proof('$GRACE','$pay6','$GRACE/c.jpg','sha-c','mtn',NULL,NULL,jsonb_build_object('status','read','tid','6001','amount',500000,'phone','0772123456','paid_at',(now()+interval '1 minute')::text))->>'code','ok')" 0); wait
check "release vs upload: the release (first) ends the hold" "$(cat /tmp/dp7_r3a)" "expired"
check "release vs upload: the upload waits, then is told not_held (nothing saved)" "$r3b" "not_held"
check "release vs upload: no proof row on the released payment" "$(q "select count(*) from funder_offplatform_rent_proofs where payment_id='$pay6'")" "0"

echo "races passed $pass / $total"
