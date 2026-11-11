#!/usr/bin/env bash
# Race tests on the throwaway DB, run after test.sql (reuses its people and helpers).
set -uo pipefail
PSQL="C:/Program Files/PostgreSQL/18/bin/psql.exe"
q()   { "$PSQL" -h localhost -p 55432 -U postgres -d cosup_test -X -q -At -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
qas() { local who="$1"; shift; PGOPTIONS="-c request.jwt.claim.sub=$who" "$PSQL" -h localhost -p 55432 -U postgres -d cosup_test -X -q -At -c "$1" 2>&1 | tr -d '\r'; }
id()  { q "select t('$1')"; }
A=$(id A); B=$(id B); D=$(id D); C=$(id C)
ROUNDS=${ROUNDS:-12}; FAIL=0
ok()  { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; FAIL=1; }

new_plan() { q "select t_plan('R$1', 300000)" >/dev/null; q "select t('R$1')"; }
topup()    { q "select t_credit('A', 400000), t_credit('B', 400000), t_credit('D', 400000), t_credit('C', 400000)" >/dev/null; }

echo "R1 two partners accept the same link at once"
for i in $(seq 1 $ROUNDS); do
  topup; P=$(new_plan 1_$i)
  CODE=$(qas "$A" "select co_support_create('$P')->>'code'")
  qas "$B" "select (co_support_accept('$CODE'))->>'ok'" > /tmp/r1b.$i &
  qas "$D" "select (co_support_accept('$CODE'))->>'ok'" > /tmp/r1d.$i &
  wait
  RES=$(q "select (select count(*) from agent_landlord_float_allocations where rent_request_id='$P')
       || ',' || (select count(*) from partner_self_funding_lines where rent_request_id='$P')
       || ',' || (select coalesce(sum(amount),0) from general_ledger where category='supporter_rent_fund'
                   and source_id in (select id from partner_self_funding_lines where rent_request_id='$P'))
       || ',' || (select count(distinct partner_id) from partner_self_funding_lines where rent_request_id='$P')")
  WIN=$(cat /tmp/r1b.$i /tmp/r1d.$i | grep -c '^true$')
  if [ "$RES" = "1,2,306000,2" ] && [ "$WIN" = "1" ]; then :; else bad "R1 round $i: $RES winners=$WIN :: $(cat /tmp/r1b.$i /tmp/r1d.$i | tr '\n' ' ')"; fi
done
[ $FAIL = 0 ] && ok "R1 ($ROUNDS rounds): one winner, one allocation of 300,000, 306,000 debited"

echo "R2 lead cancels while partner accepts"
F0=$FAIL
for i in $(seq 1 $ROUNDS); do
  topup; P=$(new_plan 2_$i)
  J=$(qas "$A" "select co_support_create('$P')::text")
  CODE=$(q "select '$J'::jsonb->>'code'"); IID=$(q "select '$J'::jsonb->>'id'")
  qas "$B" "select (co_support_accept('$CODE'))->>'ok'" > /tmp/r2b.$i &
  qas "$A" "select (co_support_cancel('$IID'))->>'status'" > /tmp/r2a.$i &
  wait
  ST=$(q "select status from co_support_invites where id='$IID'")
  ALLOC=$(q "select count(*) from agent_landlord_float_allocations where rent_request_id='$P'")
  HOLD=$(q "select count(*) from co_support_invites where lead_partner_id='$A' and status='open'")
  if { [ "$ST" = "completed" ] && [ "$ALLOC" = "1" ]; } || { [ "$ST" = "cancelled" ] && [ "$ALLOC" = "0" ]; }; then :; else bad "R2 round $i: status=$ST alloc=$ALLOC"; fi
  [ "$HOLD" = "0" ] || bad "R2 round $i: hold left"
done
[ $FAIL = $F0 ] && ok "R2 ($ROUNDS rounds): either completed with float released, or cancelled with nothing moved"

echo "R3 two partners start sharing the same plan at once"
F0=$FAIL
for i in $(seq 1 $ROUNDS); do
  topup; P=$(new_plan 3_$i)
  qas "$A" "select co_support_create('$P')->>'status'" > /tmp/r3a.$i &
  qas "$C" "select co_support_create('$P')->>'status'" > /tmp/r3c.$i &
  wait
  OPEN=$(q "select count(*) from co_support_invites where rent_request_id='$P' and status='open'")
  WIN=$(cat /tmp/r3a.$i /tmp/r3c.$i | grep -c '^open$')
  [ "$OPEN" = "1" ] && [ "$WIN" = "1" ] || bad "R3 round $i: open=$OPEN winners=$WIN :: $(cat /tmp/r3a.$i /tmp/r3c.$i | tr '\n' ' ')"
  q "select 1 from co_support_invites where rent_request_id='$P' and status='open'" >/dev/null
  # clean up the hold so later rounds have float
  for W in "$A" "$C"; do qas "$W" "select co_support_cancel(id) from co_support_invites where rent_request_id='$P' and status='open' and lead_partner_id='$W'" >/dev/null; done
done
[ $FAIL = $F0 ] && ok "R3 ($ROUNDS rounds): exactly one invite per plan"

echo "R4 lead pays alone while partner accepts"
F0=$FAIL
for i in $(seq 1 $ROUNDS); do
  topup; P=$(new_plan 4_$i)
  J=$(qas "$A" "select co_support_create('$P')::text")
  CODE=$(q "select '$J'::jsonb->>'code'"); IID=$(q "select '$J'::jsonb->>'id'")
  qas "$B" "select (co_support_accept('$CODE'))->>'ok'" > /tmp/r4b.$i &
  qas "$A" "select (co_support_fund_alone('$IID'))->>'ok'" > /tmp/r4a.$i &
  wait
  RES=$(q "select (select count(*) from agent_landlord_float_allocations where rent_request_id='$P')
       || ',' || (select sum(allocated_amount) from agent_landlord_float_allocations where rent_request_id='$P')
       || ',' || (select coalesce(sum(amount),0) from general_ledger where category='supporter_rent_fund'
                   and source_id in (select id from partner_self_funding_lines where rent_request_id='$P'))")
  [ "$RES" = "1,300000,306000" ] || bad "R4 round $i: $RES :: $(cat /tmp/r4b.$i /tmp/r4a.$i | tr '\n' ' ')"
done
[ $FAIL = $F0 ] && ok "R4 ($ROUNDS rounds): plan funded exactly once (306,000 in, 300,000 to the landlord float)"

echo "Ledger check: every wallet stays >= 0"
NEG=$(q "select count(*) from (select user_id, sum(case when direction='cash_in' then amount else -amount end) b from general_ledger where ledger_scope='wallet' group by user_id) x where b < 0")
[ "$NEG" = "0" ] && ok "no negative wallet" || bad "negative wallets: $NEG"

[ $FAIL = 0 ] && echo "ALL RACE TESTS PASSED" || echo "RACE TESTS FAILED"
