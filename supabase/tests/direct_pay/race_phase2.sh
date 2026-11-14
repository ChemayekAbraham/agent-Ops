#!/usr/bin/env bash
# Author: SSENKAALI PIUS
# Email: ssenkaali.pius@welileapp.com
# Date: 2026-11-13
# Website: welileapp.com
#
# Option 2 phase 2: real concurrent sessions on a copy of the fixture database (default dp_p2).
# Each race: session 1 claims and keeps its transaction open for 2 s; session 2 starts 0.5 s later.
set -uo pipefail
export PGCLIENTENCODING=UTF8
P="${PSQL:-C:/Program Files/PostgreSQL/18/bin/psql.exe}"; SRC="${SRC:-dp_p2}"; DB="${DB:-dp_p2_race}"
GRACE=11111111-1111-4111-8111-111111111111; BRIAN=33333333-3333-4333-8333-333333333333
plan() { printf 'a0a0a0a0-0000-4000-8000-0000000000%02d' "$1"; }
q() { "$P" -h localhost -p 55432 -U postgres -d "$DB" -X -At -q -c "SET client_min_messages = warning" "$@"; }
session() { # $1 user, $2 sql, $3 sleep-before-commit
  "$P" -h localhost -p 55432 -U postgres -d "$DB" -X -At -q -c "SET client_min_messages = warning" \
    -c "BEGIN" -c "SELECT set_config('request.jwt.claim.sub', '$1', true)" -c "$2" -c "SELECT pg_sleep($3)" -c "COMMIT" 2>&1 | grep -v '^$' | head -2 | tail -1
}
"$P" -h localhost -p 55432 -U postgres -d postgres -X -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB TEMPLATE $SRC" 2>&1 | grep -v NOTICE
pass=0; total=0
check() { total=$((total+1)); if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS  $1"; else echo "FAIL  $1: got [$2] want [$3]"; fi; }

# Race 1: two partners direct-claim R10 at the same moment.
session $GRACE "SELECT direct_pay_claim('$(plan 10)')->>'status'" 2 > /tmp/dp_r1a & sleep 0.5
r1b=$(session $BRIAN "SELECT coalesce(direct_pay_claim('$(plan 10)')->>'code', 'ok')" 0); wait
check "direct vs direct: first claim holds" "$(cat /tmp/dp_r1a)" "held"
check "direct vs direct: second claim waits, then is told taken" "$r1b" "taken"
check "direct vs direct: exactly one live hold on the plan" "$(q -c "select count(*) from funder_offplatform_rent_payments where rent_request_id='$(plan 10)' and flow='direct_pay' and status='held'")" "1"

# Race 2: Brian's wallet claim of R8 is mid-transaction when Grace direct-claims R8.
session $BRIAN "SELECT jsonb_array_length(partner_self_claim_plans(ARRAY['$(plan 8)']::uuid[], 'race2')->'claimed')" 2 > /tmp/dp_r2a & sleep 0.5
r2b=$(session $GRACE "SELECT coalesce(direct_pay_claim('$(plan 8)')->>'code', 'ok')" 0); wait
check "wallet first: wallet claim keeps the plan" "$(cat /tmp/dp_r2a)" "1"
check "wallet first: direct claim waits, then is told taken" "$r2b" "taken"
check "wallet first: no direct-pay row for the plan" "$(q -c "select count(*) from funder_offplatform_rent_payments where rent_request_id='$(plan 8)' and flow='direct_pay' and status in ('held','pending')")" "0"

# Race 3: Grace's direct claim of R6 is mid-transaction when Brian wallet-claims R6.
session $GRACE "SELECT direct_pay_claim('$(plan 6)')->>'status'" 2 > /tmp/dp_r3a & sleep 0.5
r3b=$(session $BRIAN "SELECT jsonb_array_length(partner_self_claim_plans(ARRAY['$(plan 6)']::uuid[], 'race3')->'claimed')" 0); wait
check "direct first: direct claim holds" "$(cat /tmp/dp_r3a)" "held"
check "direct first: the wallet claim gets nothing (no wait, no deadlock)" "$r3b" "0"
check "direct first: no wallet claim row for the plan" "$(q -c "select count(*) from partner_self_plan_claims where rent_request_id='$(plan 6)' and status in ('held','confirmed')")" "0"

# Race 4: two wallet claims over overlapping plans in opposite order (the deadlock case the try-lock avoids).
session $GRACE "SELECT jsonb_array_length(partner_self_claim_plans(ARRAY['$(plan 3)','$(plan 4)']::uuid[], 'race4a')->'claimed')" 2 > /tmp/dp_r4a & sleep 0.3
r4b=$(session $BRIAN "SELECT jsonb_array_length(partner_self_claim_plans(ARRAY['$(plan 4)','$(plan 3)']::uuid[], 'race4b')->'claimed')" 0); wait
check "overlapping wallet claims: no deadlock, every plan claimed at most once" \
  "$(q -c "select count(*) = count(distinct rent_request_id) from partner_self_plan_claims where rent_request_id in ('$(plan 3)','$(plan 4)') and status in ('held','confirmed')")" "t"
r4a=$(cat /tmp/dp_r4a)
check "overlapping wallet claims: both sessions finish with a count, no deadlock error" \
  "$( [[ "$r4a" =~ ^[0-9]+$ && "$r4b" =~ ^[0-9]+$ ]] && echo ok || echo "a=[$r4a] b=[$r4b]")" "ok"

echo "races passed $pass / $total"
