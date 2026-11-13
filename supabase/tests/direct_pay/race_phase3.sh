#!/usr/bin/env bash
# Author: SSENKAALI PIUS
# Email: ssenkaali.pius@welileapp.com
# Date: 2026-11-13
# Website: welileapp.com
#
# Option 2 phase 3: real concurrent sessions on a copy of a database that has phases 1-3 and phase2_fixture.sql.
# Race 1: two officers approve the same payment at the same moment.  Race 2: approve and reject at the same moment.
set -uo pipefail
export PGCLIENTENCODING=UTF8
P="${PSQL:-C:/Program Files/PostgreSQL/18/bin/psql.exe}"; SRC="${SRC:-dp_p3}"; DB="${DB:-dp_p3_race}"
GRACE=11111111-1111-4111-8111-111111111111; LUCY=66666666-6666-4666-8666-666666666666; LIZ=69696969-6969-4969-8969-696969696969
plan() { printf 'a0a0a0a0-0000-4000-8000-0000000000%02d' "$1"; }
q() { "$P" -h localhost -p 55432 -U postgres -d "$DB" -X -At -q -c "SET client_min_messages = warning" -c "$1"; }
session() { # $1 user, $2 sql, $3 sleep-before-commit
  "$P" -h localhost -p 55432 -U postgres -d "$DB" -X -At -q -c "SET client_min_messages = warning" \
    -c "BEGIN" -c "SELECT set_config('request.jwt.claim.sub', '$1', true)" -c "$2" -c "SELECT pg_sleep($3)" -c "COMMIT" 2>&1 | grep -v '^$' | head -2 | tail -1
}
"$P" -h localhost -p 55432 -U postgres -d postgres -X -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB TEMPLATE $SRC" 2>&1 | grep -v NOTICE
pass=0; total=0
check() { total=$((total+1)); if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS  $1"; else echo "FAIL  $1: got [$2] want [$3]"; fi; }

# Two Landlord Ops officers; two pending payments from Grace (R1 and R2... R2's landlord is unverified, so R6).
"$P" -h localhost -p 55432 -U postgres -d "$DB" -X -q -v ON_ERROR_STOP=1 <<SQL >/dev/null
SET client_min_messages = warning;
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO auth.users (id) VALUES ('$LUCY'), ('$LIZ');
INSERT INTO profiles (id, full_name, email, phone) VALUES ('$LUCY', 'Lucy', 'lucy@example.test', '0700000006'), ('$LIZ', 'Liz', 'liz@example.test', '0700000009');
INSERT INTO user_roles (user_id, role, enabled) VALUES ('$LUCY', 'landlord_ops', true), ('$LIZ', 'landlord_ops', true);
SET LOCAL session_replication_role = origin;
SELECT set_config('request.jwt.claim.sub', '$GRACE', true);
SELECT direct_pay_claim('$(plan 1)'); SELECT direct_pay_claim('$(plan 6)');
SELECT direct_pay_record_proof('$GRACE', (SELECT id FROM funder_offplatform_rent_payments WHERE rent_request_id = '$(plan 1)' AND flow = 'direct_pay'),
  '$GRACE/a.jpg', 'sha-a', 'mtn', NULL, NULL, jsonb_build_object('status','read','tid','5551','amount',500000,'phone','0772123456','paid_at',(now()+interval '1 minute')::text));
SELECT direct_pay_record_proof('$GRACE', (SELECT id FROM funder_offplatform_rent_payments WHERE rent_request_id = '$(plan 6)' AND flow = 'direct_pay'),
  '$GRACE/b.jpg', 'sha-b', 'mtn', NULL, NULL, jsonb_build_object('status','read','tid','5552','amount',500000,'phone','0772123456','paid_at',(now()+interval '1 minute')::text));
CREATE TABLE public.t_race_codes AS
  SELECT p.rent_request_id, (public.direct_pay_otp_issue('$LUCY', p.id))->>'otp' AS otp, p.id AS payment_id
    FROM funder_offplatform_rent_payments p WHERE p.flow = 'direct_pay' AND p.status = 'pending';
COMMIT;
SQL
pay1=$(q "select payment_id from t_race_codes where rent_request_id = '$(plan 1)'"); otp1=$(q "select otp from t_race_codes where rent_request_id = '$(plan 1)'")
pay6=$(q "select payment_id from t_race_codes where rent_request_id = '$(plan 6)'"); otp6=$(q "select otp from t_race_codes where rent_request_id = '$(plan 6)'")

# Race 1: Lucy and Liz approve R1 together.
session $LUCY "SELECT coalesce(direct_pay_approve('$pay1', '$otp1', 'Lucy called Okello', NULL)->>'code', 'ok')" 2 > /tmp/dp3_r1a & sleep 0.5
r1b=$(session $LIZ "SELECT coalesce(direct_pay_approve('$pay1', '$otp1', 'Liz called Okello', NULL)->>'code', 'ok')" 0); wait
check "two officers: the first approval wins" "$(cat /tmp/dp3_r1a)" "ok"
check "two officers: the second waits, then sees not_pending" "$r1b" "not_pending"
check "two officers: exactly one portfolio, one commitment, one receipt" \
  "$(q "select (select count(*) from funder_pending_portfolios fp join funder_offplatform_rent_payments p on p.portfolio_id = fp.portfolio_id where p.id = '$pay1') || '/' || (select count(*) from partner_self_commitments where idempotency_key = 'direct-pay-$pay1') || '/' || (select count(*) from landlord_payout_receipts where payout_id = '$pay1')")" "1/1/1"
check "two officers: the agent was paid once" \
  "$(q "select count(*) from general_ledger where idempotency_key = 'direct-pay-commission-$pay1'")" "2"

# Race 2: Lucy approves R6 while Liz rejects it.
session $LUCY "SELECT coalesce(direct_pay_approve('$pay6', '$otp6', 'Lucy called Okello', NULL)->>'code', 'ok')" 2 > /tmp/dp3_r2a & sleep 0.5
r2b=$(session $LIZ "SELECT coalesce(direct_pay_reject('$pay6', 'Liz: landlord did not answer')->>'code', 'ok')" 0); wait
check "approve vs reject: the approval (first) wins" "$(cat /tmp/dp3_r2a)" "ok"
check "approve vs reject: the reject waits, then sees not_pending" "$r2b" "not_pending"
check "approve vs reject: final state confirmed, proofs approved" \
  "$(q "select status || '/' || (select string_agg(distinct status, ',') from funder_offplatform_rent_proofs where payment_id = '$pay6') from funder_offplatform_rent_payments where id = '$pay6'")" "confirmed/approved"

echo "races passed $pass / $total"
