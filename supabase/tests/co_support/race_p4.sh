#!/usr/bin/env bash
# House races on a fresh Phase 1 + 4 DB.
set -uo pipefail
S="C:/Users/USER/AppData/Local/Temp/claude/687f05eb529ad92c/a1fdda05-4906-4282-adaf-8aee51ff8509/scratchpad/cosup"
PSQL="C:/Program Files/PostgreSQL/18/bin/psql.exe"
q()   { "$PSQL" -h localhost -p 55432 -U postgres -d cosup_test -X -q -At -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
qas() { local who="$1"; shift; PGOPTIONS="-c request.jwt.claim.sub=$who" "$PSQL" -h localhost -p 55432 -U postgres -d cosup_test -X -q -At -c "$1" 2>&1 | tr -d '\r'; }
ROUNDS=${ROUNDS:-10}; FAIL=0
ok()  { echo "  ok   $1"; }; bad() { echo "  FAIL $1"; FAIL=1; }
cd "$S" && "$PSQL" -h localhost -p 55432 -U postgres -d cosup_test -X -q -f harness.sql >/dev/null 2>&1
q "create or replace function hh_house(p_rent int default 300000) returns uuid language sql as \$\$ insert into house_listings (agent_id, title, district, monthly_rent) values (gen_random_uuid(), 'House', 'Wakiso', p_rent) returning id \$\$" >/dev/null
OPS1=$(q "select tt_person(15,0,true,false)"); OPS2=$(q "select tt_person(15,0,true,false)")
q "insert into t_staff values ('$OPS1'), ('$OPS2')" >/dev/null

pair() { # prints: house invite_code lead_portfolio invitee_portfolio a b
  local a b h code
  a=$(q "select tt_person(15, 200000)"); b=$(q "select tt_person(15, 200000)"); h=$(q "select hh_house(300000)")
  code=$(qas "$a" "select co_support_create_house('$h')->>'code'")
  echo "$h $code $a $b"
}

echo "R5 two partners accept the same house link at once"
for i in $(seq 1 $ROUNDS); do
  a=$(q "select tt_person(15, 200000)"); b=$(q "select tt_person(15, 200000)"); d=$(q "select tt_person(15, 200000)"); h=$(q "select hh_house(300000)")
  code=$(qas "$a" "select co_support_create_house('$h')->>'code'")
  qas "$b" "select (co_support_accept('$code'))->>'ok'" > /tmp/h5b.$i &
  qas "$d" "select (co_support_accept('$code'))->>'ok'" > /tmp/h5d.$i &
  wait
  RES=$(q "select count(*) from partner_supported_houses where house_id='$h' and status='pending'")
  WIN=$(cat /tmp/h5b.$i /tmp/h5d.$i | grep -c '^true$')
  [ "$RES" = "2" ] && [ "$WIN" = "1" ] || bad "R5 round $i: rows=$RES winners=$WIN :: $(cat /tmp/h5b.$i /tmp/h5d.$i | tr '\n' ' ')"
done
[ $FAIL = 0 ] && ok "R5 ($ROUNDS rounds): one winner, exactly two pending halves"

echo "R6 two reviewers approve the two halves at the same moment"
F0=$FAIL
for i in $(seq 1 $ROUNDS); do
  read -r h code a b <<<"$(pair)"
  qas "$b" "select co_support_accept('$code')" >/dev/null
  read -r pa pb <<<"$(q "select lead_portfolio_id || ' ' || invitee_portfolio_id from co_support_invites where code='$code'")"
  qas "$OPS1" "select approve_pending_portfolio('$pa')" > /tmp/h6a.$i &
  qas "$OPS2" "select approve_pending_portfolio('$pb')" > /tmp/h6b.$i &
  wait
  RES=$(q "select (select count(*) from partner_supported_houses where house_id='$h' and status='active') || ',' ||
                  (select coalesce(sum(amount),0) from general_ledger where ledger_scope='wallet' and direction='cash_out'
                     and category='supporter_rent_fund' and source_id in (select id from partner_supported_houses where house_id='$h'))")
  [ "$RES" = "2,306000" ] || bad "R6 round $i: $RES :: $(cat /tmp/h6a.$i /tmp/h6b.$i | tr '\n' ' ')"
done
[ $FAIL = $F0 ] && ok "R6 ($ROUNDS rounds): both halves approved once, 306,000 debited once (no deadlock, no double debit)"

echo "R7 one reviewer approves while another rejects"
F0=$FAIL
for i in $(seq 1 $ROUNDS); do
  read -r h code a b <<<"$(pair)"
  qas "$b" "select co_support_accept('$code')" >/dev/null
  read -r pa pb <<<"$(q "select lead_portfolio_id || ' ' || invitee_portfolio_id from co_support_invites where code='$code'")"
  qas "$OPS1" "select approve_pending_portfolio('$pa')" > /tmp/h7a.$i &
  qas "$OPS2" "select reject_pending_portfolio('$pb', 'race test rejection')" > /tmp/h7b.$i &
  wait
  RES=$(q "select string_agg(status, ',' order by status) from partner_supported_houses where house_id='$h'")
  DEB=$(q "select coalesce(sum(amount),0) from general_ledger where ledger_scope='wallet' and direction='cash_out' and category='supporter_rent_fund' and source_id in (select id from partner_supported_houses where house_id='$h')")
  if { [ "$RES" = "active,active" ] && [ "$DEB" = "306000" ]; } || { [ "$RES" = "cancelled,cancelled" ] && [ "$DEB" = "0" ]; }; then :; else
    bad "R7 round $i: rows=$RES debited=$DEB :: $(cat /tmp/h7a.$i /tmp/h7b.$i | tr '\n' ' ')"; fi
done
[ $FAIL = $F0 ] && ok "R7 ($ROUNDS rounds): always both approved or both rejected, never one of each"

echo "R8 sender pays alone while a partner accepts the house"
F0=$FAIL
for i in $(seq 1 $ROUNDS); do
  a=$(q "select tt_person(15, 400000)"); b=$(q "select tt_person(15, 200000)"); h=$(q "select hh_house(300000)")
  J=$(qas "$a" "select co_support_create_house('$h')::text"); code=$(q "select '$J'::jsonb->>'code'"); iid=$(q "select '$J'::jsonb->>'id'")
  qas "$b" "select (co_support_accept('$code'))->>'ok'" > /tmp/h8b.$i &
  qas "$a" "select (co_support_fund_alone('$iid'))->>'ok'" > /tmp/h8a.$i &
  wait
  RES=$(q "select coalesce(sum(principal),0) from partner_supported_houses where house_id='$h' and status in ('pending','active')")
  [ "$RES" = "306000" ] || bad "R8 round $i: principal=$RES :: $(cat /tmp/h8b.$i /tmp/h8a.$i | tr '\n' ' ')"
done
[ $FAIL = $F0 ] && ok "R8 ($ROUNDS rounds): the house is supported exactly once (306,000)"

INT=$(q "select count(*) from co_support_integrity_check()")
[ "$INT" = "0" ] && ok "integrity check empty after all races" || bad "integrity rows: $INT"
[ $FAIL = 0 ] && echo "ALL HOUSE RACE TESTS PASSED" || echo "HOUSE RACE TESTS FAILED"
