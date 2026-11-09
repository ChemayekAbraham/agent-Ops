#!/usr/bin/env bash
# P2 (design v2 §10.3): promissory-note activation under contention, against a THROWAWAY local Postgres (port 55432).
# Prerequisite: the Phase 4 load (run_phase4_tests.sh race does it). Never point this at production.
# (Replaces the 5 Nov race script of the superseded per-contract design.)
#
#  P2a two people activate the same pending note at the same moment (one holds its transaction 1 s): exactly one links,
#      the other gets NOTE_LINKED_ELSEWHERE and nothing of theirs is written (both start orders)
#  P2b the same person activates the same note from two sessions at once: one activation, one "already active", one event
#  P2c two people race for an ACTIVATED unlinked note (the link-only path)
#  P2d the note row is held by another transaction for 7 s: activation gives up after its own 5 s lock_timeout (55P03),
#      changes nothing, and works once the row is free
PSQL="${PSQL:-C:/Program Files/PostgreSQL/18/bin/psql.exe}"
PORT="${PORT:-55432}"
PGDB="${PGDB:-postgres}"
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/out_race_phase4"; rm -rf "$OUT"; mkdir -p "$OUT"
q()  { "$PSQL" -h localhost -p "$PORT" -U postgres -d "$PGDB" -X -q -At -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
# Background session as a signed-in person: $1 = output name, $2 = person (pid name), $3 = SQL
bg() { PGOPTIONS="-c request.jwt.claim.sub=$(q "SELECT public.pid('$2')") -c request.jwt.claim.role=authenticated" \
         "$PSQL" -h localhost -p "$PORT" -U postgres -d "$PGDB" -X -q -At -v VERBOSITY=verbose -c "$3" > "$OUT/$1" 2>&1 & }
pass=0; fail=0
check() { if [ "$2" == "$3" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1  got [$2] want [$3]"; fail=$((fail+1)); fi; }
tok() { echo "tok-race-$1-padding-0000"; }
# outcome of one session: linked | already | elsewhere | timeout | other:<first error line>
outcome() {
  local f="$OUT/$1"
  if grep -q '"already_active": false' "$f"; then echo linked
  elif grep -q '"already_active": true' "$f"; then echo already
  elif grep -q 'NOTE_LINKED_ELSEWHERE' "$f"; then echo elsewhere
  elif grep -q '55P03' "$f"; then echo timeout
  else echo "other:$(grep -m1 -E 'ERROR|FATAL' "$f" | tr -d '\r')"; fi
}
state() { # status|who (ra / rb / nobody)|events|roles of ra|roles of rb
  q "SELECT n.status || '|' || CASE n.partner_user_id WHEN public.pid('ra') THEN 'ra' WHEN public.pid('rb') THEN 'rb' ELSE COALESCE(n.partner_user_id::text, 'nobody') END
          || '|' || (SELECT count(*) FROM public.system_events e WHERE e.event_type = 'promissory_note_activated' AND e.metadata ->> 'note_id' = n.id::text)
          || '|' || (SELECT count(*) FROM public.user_roles r WHERE r.user_id = public.pid('ra'))
          || '|' || (SELECT count(*) FROM public.user_roles r WHERE r.user_id = public.pid('rb'))
       FROM public.promissory_notes n WHERE n.activation_token = '$(tok "$1")'"
}
reset_people() { q "DELETE FROM public.user_roles WHERE user_id IN (public.pid('ra'), public.pid('rb'))" >/dev/null; }

q "INSERT INTO auth.users (id, email) VALUES (public.pid('ra'), 'ra@race.test'), (public.pid('rb'), 'rb@race.test') ON CONFLICT DO NOTHING" >/dev/null
q "INSERT INTO public.promissory_notes (agent_id, partner_name, whatsapp_number, amount, status, fulfilment_due_on, activation_token)
   SELECT public.pid('agent1'), 'Race ' || k, '07789' || lpad(i::text, 5, '0'), 300000, CASE WHEN k LIKE 'act%' THEN 'activated' ELSE 'pending' END,
          current_date + 5, 'tok-race-' || k || '-padding-0000'
     FROM (VALUES (1, 'a1'), (2, 'a2'), (3, 'a3'), (4, 'b1'), (5, 'b2'), (6, 'same1'), (7, 'same2'), (8, 'act1'), (9, 'act2'),
                  (10, 'lock1')) v(i, k)" >/dev/null
ACT="SELECT public.activate_promissory_note"

echo "== P2a two people activate the same pending note at once (the first holds its transaction 1 s)"
for r in a1 a2 a3 b1 b2; do
  reset_people
  if [ "${r:0:1}" = a ]; then first=ra; second=rb; else first=rb; second=ra; fi
  bg first "$first" "BEGIN; $ACT('$(tok $r)'); SELECT pg_sleep(1); COMMIT;"
  sleep 0.3
  bg second "$second" "$ACT('$(tok $r)');"
  wait
  check "P2a.$r ($first first): the first links, the second is refused NOTE_LINKED_ELSEWHERE; one event; only the first got roles" \
    "$(outcome first)/$(outcome second)/$(state $r)" \
    "linked/elsewhere/activated|$first|1|$([ $first = ra ] && echo 4 || echo 0)|$([ $first = rb ] && echo 4 || echo 0)"
done

echo "== P2b the same person activates the same note from two sessions at once"
for r in same1 same2; do
  reset_people
  bg s1 ra "BEGIN; $ACT('$(tok $r)'); SELECT pg_sleep(1); COMMIT;"
  sleep 0.3
  bg s2 ra "$ACT('$(tok $r)');"
  wait
  check "P2b.$r one activation and one 'already active'; one event; 4 roles" "$(outcome s1)/$(outcome s2)/$(state $r)" "linked/already/activated|ra|1|4|0"
done

echo "== P2c two people race for an activated, unlinked note (link-only)"
for r in act1 act2; do
  reset_people
  bg first ra "BEGIN; $ACT('$(tok $r)'); SELECT pg_sleep(1); COMMIT;"
  sleep 0.3
  bg second rb "$ACT('$(tok $r)');"
  wait
  check "P2c.$r the first links (already active, link-only event), the second is refused NOTE_LINKED_ELSEWHERE; no roles granted" \
    "$(outcome first)/$(outcome second)/$(state $r)" "already/elsewhere/activated|ra|1|0|0"
done

echo "== P2d the note row is held by another transaction for 7 s"
reset_people
"$PSQL" -h localhost -p "$PORT" -U postgres -d "$PGDB" -X -q -At \
  -c "BEGIN; SELECT 1 FROM public.promissory_notes WHERE activation_token = '$(tok lock1)' FOR UPDATE; SELECT pg_sleep(7); COMMIT;" > "$OUT/holder" 2>&1 &
sleep 0.5
t0=$(date +%s.%N)
bg waiter ra "$ACT('$(tok lock1)');"
wpid=$!
wait "$wpid"
t1=$(date +%s.%N)
wait
secs=$(awk -v a="$t0" -v b="$t1" 'BEGIN { printf "%.1f", b - a }')
inrange=$(awk -v s="$secs" 'BEGIN { print (s >= 4.5 && s <= 6.6) ? "about 5 s" : "took " s " s" }')
check "P2d activation gives up with 55P03 (lock_timeout) after about 5 s, nothing written" "$(outcome waiter)/$inrange/$(state lock1)" "timeout/about 5 s/pending|nobody|0|0|0"
bg after ra "$ACT('$(tok lock1)');"
wait
check "P2d ... and activates once the row is free" "$(outcome after)/$(state lock1)" "linked/activated|ra|1|4|0"

echo "RACE P2: $pass passed, $fail failed"
