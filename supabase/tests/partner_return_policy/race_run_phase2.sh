#!/usr/bin/env bash
# Race tests for Phase 2 (per-person Partner Returns) against a THROWAWAY local Postgres (port 55432).
# Prerequisite: race_stub.sql + race_stub_phase2.sql + both migrations loaded, switch never turned
# on (run_phase2_tests.sh does this). Never point this at production.
#
#  R1  a pre-cut-off note linked late while the same person opens a portfolio, both orders
#  R2  two statements link two pre-cut-off notes of the same person at the same time
#  R5  a staff rate request on a portfolio at the moment that portfolio's person is linked late (each round also run
#      one after the other on a control person: the outcome must be the same)
#  R6  a plain rate edit (UPDATE roi_percentage: the gate queues a rate_change) committing while the late link waits
#  R7  the split/lock tool pattern (portfolio row locked FOR UPDATE, then a portfolio opened for the same person, which
#      takes the person's rate lock) against a late link for that person: both start orders, several timings
#  R4  split bookings over overlapping houses at the same time (same, identical and opposite order)
#  R3  the CEO switches on while every creation path is running; R3b a creation held open across it (guard waits 0.5 s, Phase 6 F5)
#  Round 4:
#  R6b the late link first (held), then a plain rate edit on the same portfolio (the Phase 1 gate's retry)
#  R6c two plain rate edits on one portfolio at the same time
#  R8  the CFO batch decision vs a plain rate edit replacing the open requests of one of its portfolios (both start orders);
#      R8b (INFO) a two-row rate edit vs the CFO batch
#  R9  the late link's round 2 vs a portfolio held FOR UPDATE by a split/lock tool waiting for the link's rate lock (SKIP LOCKED)
#  R10 the late link superseding lower requests vs the CFO batch deciding them (both start orders)
#  R11 a staff request at or above / below the note rate committing inside the late link's step 2
#  Round 5 (the gate without a sub-transaction; the round-4 S8c and P2-4b fixes):
#  R6d another transaction holds a new pending request for the portfolio while a plain rate edit runs (the edit's
#      ON CONFLICT DO NOTHING waits for it, then the second try replaces it)
#  R6e the gate's second miss in a row (RAISE 23505 on portfolio_rate_approvals_one_pending): only reachable with a test-only
#      gap between the two tries (instrumented copy of the gate); the same four sessions without the gap end in one retry
#  R6f (INFO) a request committed AND scheduled by the CFO between the gate's supersede and its insert (test-only gap): the
#      gate's insert does not wait for it, so it stands beside the new pending request (the gate's own S8c-like window)
#  R9  round 5 is now a check (P2-4b): a busy portfolio that already has a pending request above the note rate sends no alert
#  R11c the CFO approves a staff 18 inside the late link's step-2 gap (round-4 S8c): no pending note request beside it
#  R9, R11 and R11c use an instrumented copy of partner_note_linked_late, R6e one of the Phase 1 gate (test-only sleeps,
#  restored and md5-checked afterwards).
#  Round 6 (portfolio_rate_approvals_one_open: at most one open request, pending or scheduled, per portfolio):
#  R6e the CFO REJECTS the first competitor in the gap (approving it no longer lets a second competitor in: round 5, new); the
#      round-5 set-up with the approval is kept as round 5 and now ends in one open request
#  R6f (counted, round-5 G13) a request committed AND approved by the CFO between the gate's supersede and its insert: the
#      insert conflicts on one_open, the second try replaces the scheduled request; the CFO can approve the edit's request
#  R8  each portfolio has ONE open request (the round-4 set-up, a pending beside a scheduled one, is now refused)
#  R11d (round-5 S8d) a lower staff request committed AND approved between the late link's step-2 supersede and its insert
#      (test-only gap t.gap3): pass 2 replaces it with the note's request; the CFO can approve that
#  R12 auto_explain of the gate's and the late link's nested INSERT ... ON CONFLICT: both arbiters, one_pending and one_open
PSQL="${PSQL:-C:/Program Files/PostgreSQL/18/bin/psql.exe}"
PORT="${PORT:-55432}"
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/out_race_phase2"; rm -rf "$OUT"; mkdir -p "$OUT"
q()   { "$PSQL" -h localhost -p "$PORT" -U postgres -d postgres -X -q -At -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
# Background session: $1 = output name, $2 = SQL, optional $3 = PGOPTIONS
bg()  { PGOPTIONS="${3:-}" "$PSQL" -h localhost -p "$PORT" -U postgres -d postgres -X -q -At -c "$2" > "$OUT/$1" 2>&1 & }
pass=0; fail=0; deadlocks=0; timeouts=0
check() { if [ "$2" == "$3" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1  got [$2] want [$3]"; fail=$((fail+1)); fi; }
note()  { echo "INFO  $*"; }
errs()  { grep -hiE "error|deadlock|timeout" "$@" 2>/dev/null | tr -d '\r' | sort | uniq -c | sed 's/^ */      /' | head -6; }
count_events() { # tally deadlocks / lock timeouts seen in the given files
  local d t; d=$(cat "$@" 2>/dev/null | grep -ci "deadlock detected"); t=$(cat "$@" 2>/dev/null | grep -ci "lock timeout")
  deadlocks=$((deadlocks + d)); timeouts=$((timeouts + t))
}
AGENT=$(q "SELECT public.pid('agent1')")
COO=$(q "SELECT public.pid('coo')")
LATE_MAILS="SELECT count(*) FROM public._email_outbox WHERE payload ->> 'subject' LIKE 'Promissory note linked late%'"

( cd "$DIR" && "$PSQL" -h localhost -p "$PORT" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f race_phase2_seed.sql ) | tr -d '\r' | grep -q seeded \
  || { echo "FAIL  race seed did not load"; exit 1; }
check "R0 Phase 2 alone does not make the switch ready: switch-on refused" \
  "$(q "SELECT public.set_partner_return_policy(true)" 2>&1 | grep -c 'is not complete')/$(q "SELECT enabled FROM public.partner_return_policy")" "1/f"
q "UPDATE public.partner_return_policy SET release_ready = true" >/dev/null   # stand-in for the release migration (Phase 7)
q "SELECT public.set_partner_return_policy(true)" >/dev/null
CUT=$(q "SELECT cutoff_at FROM public.partner_return_policy")
echo "   switch on, cut-off $CUT; existing partners: $(q "SELECT count(*) FROM public.partner_return_cohort"), note windows: $(q "SELECT count(*) FROM public.partner_return_note_windows")"

LINK() { echo "UPDATE public.profiles SET phone = '$1$(printf %06d "$2")' WHERE id = public.pid('$3'); SELECT public.link_promissory_notes_for_user(public.pid('$3'));"; }

# ===========================================================================
echo "== R1 a pre-cut-off note linked late while the same person opens a portfolio (1 s overlap)"
r1_round() { # $1 = round, $2 = order (link_first | portfolio_first)
  local i=$1 want
  if [ "$2" = link_first ]; then
    bg a "BEGIN; $(LINK 0781 "$i" "r1_$i") SELECT pg_sleep(1.0); COMMIT;"; sleep 0.3; bg b "SELECT public.t2_fcpp('r1_$i');"; wait
    want="15|promissory_note|15|-"        # the portfolio waited for the link and saw the note
  else
    bg b "BEGIN; SELECT public.t2_fcpp('r1_$i'); SELECT pg_sleep(1.0); COMMIT;"; sleep 0.3; bg a "$(LINK 0781 "$i" "r1_$i")"; wait
    want="10|new|10|15"                   # the link waited for the portfolio and queued its catch-up
  fi
  count_events "$OUT/a" "$OUT/b"
  local e; e=$(errs "$OUT/a" "$OUT/b")
  check "R1 round $i ($2): note linked, portfolio created, no error" \
    "$(q "SELECT (partner_user_id IS NOT NULL)::text FROM public.promissory_notes WHERE whatsapp_number = '0781$(printf %06d "$i")'")/$(q "SELECT count(*) FROM public.investor_portfolios WHERE investor_id = public.pid('r1_$i')")/${e:-none}" "true/1/none"
  check "R1 round $i ($2): serialised by the per-person lock -> portfolio [$want]; none left below the note rate without a CFO request" \
    "$(q "SELECT public.r_desc_person('r1_$i')")/$(q "SELECT public.r_missed('r1_$i')")" "$want/0"
}
for i in 1 2 3; do r1_round $i link_first; done
for i in 4 5 6; do r1_round $i portfolio_first; done

# ===========================================================================
echo "== R2 two statements link two pre-cut-off notes of the same person at the same time (1 s overlap)"
r2_round() { # $1 = round
  local i=$1 N1 N2 m0
  q "SELECT public.t2_port('r2_$i', NULL, 'active')" >/dev/null           # 10, opened after the cut-off
  N1=$(q "SELECT id FROM public.promissory_notes WHERE whatsapp_number = '0782$(printf %06d "$i")'")
  N2=$(q "SELECT id FROM public.promissory_notes WHERE whatsapp_number = '0783$(printf %06d "$i")'")
  m0=$(q "$LATE_MAILS")
  bg a "BEGIN; UPDATE public.promissory_notes SET partner_user_id = public.pid('r2_$i') WHERE id = '$N1'; SELECT pg_sleep(1.0); COMMIT;"
  sleep 0.3
  bg b "UPDATE public.promissory_notes SET partner_user_id = public.pid('r2_$i') WHERE id = '$N2';"
  wait
  count_events "$OUT/a" "$OUT/b"
  local e; e=$(errs "$OUT/a" "$OUT/b")
  check "R2 round $i: both linking statements succeed (both notes linked, no error)" \
    "$(q "SELECT count(*) FROM public.promissory_notes WHERE id IN ('$N1','$N2') AND partner_user_id = public.pid('r2_$i')")/${e:-none}" "2/none"
  check "R2 round $i: exactly one pending note_late_link request; one alert pair (the second linker queued nothing, sent nothing)" \
    "$(q "SELECT count(*) || ':' || string_agg(a.source || '@' || trim_scale(a.requested_rate), ',') FROM public.portfolio_rate_approvals a JOIN public.investor_portfolios ip ON ip.id = a.portfolio_id WHERE ip.investor_id = public.pid('r2_$i') AND a.status = 'pending'")/$(( $(q "$LATE_MAILS") - m0 ))" \
    "1:note_late_link@15/2"
}
for i in 1 2 3 4 5 6; do r2_round $i; done

# ===========================================================================
echo "== R5 a staff rate request (set_portfolio_renewal_rate, COO) on the same portfolio at the moment its person is linked late"
STAFF_OPTS="-c request.jwt.claim.sub=$COO -c request.jwt.claim.role=authenticated"
staff_call() { PGOPTIONS="$STAFF_OPTS" q "SELECT public.set_portfolio_renewal_rate('$1', $2) ->> 'awaits_cfo'" 2>&1; }
r5_round() { # $1 = round, $2 = order (staff_first | link_first), $3 = the staff's requested rate, $4 = how long the first session holds (s)
  local i=$1 P PC m0 m1 mc0 mc1 sres
  P=$(q "SELECT public.t2_port('r5_$i', NULL, 'active')")               # 10, opened after the cut-off
  PC=$(q "SELECT public.t2_port('r5c_$i', NULL, 'active')")             # the control person's portfolio
  m0=$(q "$LATE_MAILS")
  if [ "$2" = staff_first ]; then
    bg s "BEGIN; SELECT public.set_portfolio_renewal_rate('$P', $3) ->> 'awaits_cfo'; SELECT pg_sleep($4); COMMIT;" "$STAFF_OPTS"
    sleep 0.3; bg a "$(LINK 0785 "$i" "r5_$i")"; wait
  else
    bg a "BEGIN; $(LINK 0785 "$i" "r5_$i") SELECT pg_sleep($4); COMMIT;"
    sleep 0.3; bg s "SELECT public.set_portfolio_renewal_rate('$P', $3) ->> 'awaits_cfo';" "$STAFF_OPTS"; wait
  fi
  m1=$(q "$LATE_MAILS")
  # The same two actions one after the other (in the order they committed above), on the control person.
  mc0=$(q "$LATE_MAILS")
  if [ "$2" = staff_first ]; then staff_call "$PC" "$3" >/dev/null; q "$(LINK 0786 "$i" "r5c_$i")" >/dev/null
  else q "$(LINK 0786 "$i" "r5c_$i")" >/dev/null; staff_call "$PC" "$3" >/dev/null; fi
  mc1=$(q "$LATE_MAILS")
  count_events "$OUT/a" "$OUT/s"
  local ea; ea=$(errs "$OUT/a")
  sres=$(tr -d '\r' < "$OUT/s" | grep -m1 -E 'ERROR|^(true|false)$' | cut -c1-100)
  check "R5 round $i ($2 held $4 s, staff asks $3): the link commits (note linked, no error in the linking session)"     "$(q "SELECT (partner_user_id IS NOT DISTINCT FROM public.pid('r5_$i'))::text FROM public.promissory_notes WHERE whatsapp_number = '0785$(printf %06d "$i")'")/${ea:-none}" "true/none"
  check "R5 round $i ($2 held $4 s, staff asks $3): no deadlock in either session; the staff call succeeds (awaits_cfo)" "$(cat "$OUT/a" "$OUT/s" | grep -ci 'deadlock detected')/$sres" "0/true"
  # r_missed: portfolios left below the note rate with no request at or above it. 0 when the staff call came first; 1 when it
  # came after the link and asked less than the note (the staff's newer request replaces the note's, as the gate does).
  check "R5 round $i ($2 held $4 s, staff asks $3): same requests, alert mails and r_missed as one after the other [$(q "SELECT public.r_hist('$PC')") / $((mc1 - mc0)) mails / r_missed $(q "SELECT public.r_missed('r5c_$i')")]" \
    "$(q "SELECT public.r_hist('$P')")/$((m1 - m0))/$(q "SELECT public.r_missed('r5_$i')")" "$(q "SELECT public.r_hist('$PC')")/$((mc1 - mc0))/$(q "SELECT public.r_missed('r5c_$i')")"
}
r5_round 1 staff_first 15 1.0
r5_round 2 staff_first 20 1.0
r5_round 3 staff_first 12 1.0
r5_round 4 link_first 12 1.0
r5_round 5 link_first 20 1.0
r5_round 6 link_first 12 1.5
r5_round 7 link_first 20 1.5
r5_round 8 staff_first 12 1.5
r5_round 9 staff_first 20 1.5
r5_round 10 link_first 12 0.5
check "R5 the expected outcomes (sequential controls): staff 12 first -> 12 superseded + note 15 pending; staff 15/20 first -> theirs stands, no note request; link first -> the note's 15 superseded by the staff's request" \
  "$(q "SELECT public.r_hist_person('r5c_3') || ' | ' || public.r_hist_person('r5c_1') || ' | ' || public.r_hist_person('r5c_2') || ' | ' || public.r_hist_person('r5c_4') || ' | ' || public.r_hist_person('r5c_5')")" \
  "note_late_link@15:pending,rate_change@12:superseded | rate_change@15:pending | rate_change@20:pending | note_late_link@15:superseded,rate_change@12:pending | note_late_link@15:superseded,rate_change@20:pending"

# ===========================================================================
echo "== R6 a plain rate edit (UPDATE roi_percentage, switch on: the gate queues a rate_change) committing while the late link waits"
r6_round() { # $1 = round, $2 = typed rate, $3 = how long the edit is held (s); the link starts 0.5 s after the edit
  local i=$1 P PC m0 m1 mc0 mc1
  P=$(q "SELECT public.t2_port('r6_$i', NULL, 'active')"); PC=$(q "SELECT public.t2_port('r6c_$i', NULL, 'active')")
  m0=$(q "$LATE_MAILS")
  bg g "BEGIN; UPDATE public.investor_portfolios SET roi_percentage = $2 WHERE id = '$P'; SELECT pg_sleep($3); COMMIT;"
  sleep 0.5; bg a "$(LINK 0787 "$i" "r6_$i")"; wait
  m1=$(q "$LATE_MAILS")
  mc0=$(q "$LATE_MAILS")
  q "UPDATE public.investor_portfolios SET roi_percentage = $2 WHERE id = '$PC'" >/dev/null; q "$(LINK 0788 "$i" "r6c_$i")" >/dev/null
  mc1=$(q "$LATE_MAILS")
  count_events "$OUT/a" "$OUT/g"
  local e; e=$(errs "$OUT/a" "$OUT/g")
  check "R6 round $i (edit to $2 held $3 s, link 0.5 s later): both commit, no error, no deadlock" \
    "$(q "SELECT (partner_user_id IS NOT DISTINCT FROM public.pid('r6_$i'))::text FROM public.promissory_notes WHERE whatsapp_number = '0787$(printf %06d "$i")'")/${e:-none}" "true/none"
  check "R6 round $i (edit to $2 held $3 s): same requests and alert mails as one after the other [$(q "SELECT public.r_hist('$PC')") / $((mc1 - mc0)) mails]; nothing below the note rate left unqueued" \
    "$(q "SELECT public.r_hist('$P')")/$((m1 - m0))/$(q "SELECT public.r_missed('r6_$i')")" "$(q "SELECT public.r_hist('$PC')")/$((mc1 - mc0))/0"
}
r6_round 1 12 2.0
r6_round 2 18 2.0
r6_round 3 12 1.0
r6_round 4 18 1.0
check "R6 the expected outcomes (sequential controls): an edit to 12 -> 12 superseded + note 15 pending + alert; an edit to 18 stands, no note request" \
  "$(q "SELECT public.r_hist_person('r6c_1') || ' | ' || public.r_hist_person('r6c_2')")" \
  "note_late_link@15:pending,rate_change@12:superseded | rate_change@18:pending"
# The other order, for the record: the link holds its new pending request when the edit arrives.
P=$(q "SELECT public.t2_port('r6_5', NULL, 'active')"); PC=$(q "SELECT public.t2_port('r6c_5', NULL, 'active')")
bg a "BEGIN; $(LINK 0787 5 r6_5) SELECT pg_sleep(1.0); COMMIT;"
sleep 0.3; bg g "UPDATE public.investor_portfolios SET roi_percentage = 12 WHERE id = '$P';"; wait
count_events "$OUT/a" "$OUT/g"
q "$(LINK 0788 5 r6c_5)" >/dev/null; q "UPDATE public.investor_portfolios SET roi_percentage = 12 WHERE id = '$PC'" >/dev/null
note "R6 link first (held 1 s), then a plain edit to 12: edit session [$(tr -d '\r' < "$OUT/g" | grep -m1 ERROR | cut -c1-140)], link session [$(errs "$OUT/a" | head -1)], requests [$(q "SELECT public.r_hist('$P')")]; one after the other [$(q "SELECT public.r_hist('$PC')")] (round 3: the edit failed with 23505; round 4: the gate retries, see R6b)"

# ===========================================================================
echo "== R7 split/lock tool pattern (FOR UPDATE on a person's portfolio, then a new portfolio for that person) vs a late link of that person"
# Tool session: BEGIN; lock P; wait $a; open a portfolio for the person (the gate takes the rate lock); wait $b; COMMIT.
r7_round() { # $1 = round, $2 = start (tool_first | link_first), $3 = a, $4 = b, $5 = link hold (s), $6 = locked portfolio (candidate | redeemed)
  local i=$1 P PR PC PCR LOCKED LOCKEDC m0 m1 mc0 mc1 first
  P=$(q "SELECT public.t2_port('r7_$i', NULL, 'active')");  PR=$(q "SELECT public.t2_port('r7_$i', NULL, 'redeemed')")
  PC=$(q "SELECT public.t2_port('r7c_$i', NULL, 'active')"); PCR=$(q "SELECT public.t2_port('r7c_$i', NULL, 'redeemed')")
  if [ "$6" = candidate ]; then LOCKED=$P; LOCKEDC=$PC; else LOCKED=$PR; LOCKEDC=$PCR; fi
  local TOOL="BEGIN; SELECT 1 FROM public.investor_portfolios WHERE id = '$LOCKED' FOR UPDATE; SELECT pg_sleep($3); SELECT public.t2_port('r7_$i', NULL, 'pending_ops_approval'); SELECT pg_sleep($4); COMMIT; SELECT 'tool committed at ' || clock_timestamp();"
  local LNK="BEGIN; $(LINK 0789 "$i" "r7_$i") SELECT pg_sleep($5); COMMIT; SELECT 'link committed at ' || clock_timestamp();"
  m0=$(q "$LATE_MAILS")
  if [ "$2" = tool_first ]; then bg t "$TOOL"; sleep 0.3; bg a "$LNK"
  else bg a "$LNK"; sleep 0.3; bg t "$TOOL"; fi
  wait
  m1=$(q "$LATE_MAILS")
  count_events "$OUT/a" "$OUT/t"
  local e; e=$(errs "$OUT/a" "$OUT/t")
  # Which committed first (each session prints the time right after its COMMIT) decides the sequential control.
  local tool_at link_at
  tool_at=$(tr -d '\r' < "$OUT/t" | sed -n 's/^tool committed at //p'); link_at=$(tr -d '\r' < "$OUT/a" | sed -n 's/^link committed at //p')
  first=$(q "SELECT CASE WHEN '$tool_at'::timestamptz < '$link_at'::timestamptz THEN 'tool' ELSE 'link' END" 2>/dev/null)
  mc0=$(q "$LATE_MAILS")
  if [ "$first" = tool ]; then
    q "BEGIN; SELECT 1 FROM public.investor_portfolios WHERE id = '$LOCKEDC' FOR UPDATE; SELECT public.t2_port('r7c_$i', NULL, 'pending_ops_approval'); COMMIT;" >/dev/null
    q "$(LINK 0776 "$i" "r7c_$i")" >/dev/null
  else
    q "$(LINK 0776 "$i" "r7c_$i")" >/dev/null
    q "BEGIN; SELECT 1 FROM public.investor_portfolios WHERE id = '$LOCKEDC' FOR UPDATE; SELECT public.t2_port('r7c_$i', NULL, 'pending_ops_approval'); COMMIT;" >/dev/null
  fi
  mc1=$(q "$LATE_MAILS")
  check "R7 round $i ($2, tool waits $3 s + $4 s, link held $5 s, locks the $6 portfolio): both commit, no error, no deadlock" \
    "$(q "SELECT (partner_user_id IS NOT DISTINCT FROM public.pid('r7_$i'))::text FROM public.promissory_notes WHERE whatsapp_number = '0789$(printf %06d "$i")'")/$(q "SELECT count(*) FROM public.investor_portfolios WHERE investor_id = public.pid('r7_$i')")/${e:-none}" "true/3/none"
  check "R7 round $i ($first committed first): portfolios and requests equal the same two steps one after the other [$(q "SELECT public.r_desc_person('r7c_$i')")]" \
    "$(q "SELECT public.r_desc_person('r7_$i')")/$((m1 - m0))/$(q "SELECT public.r_missed('r7_$i')")" "$(q "SELECT public.r_desc_person('r7c_$i')")/$((mc1 - mc0))/0"
}
r7_round 1 tool_first 1.0 0.5 0   candidate
r7_round 2 tool_first 0   1.0 0   candidate
r7_round 3 tool_first 0.6 0.6 0   candidate
r7_round 4 link_first 0   0   1.0 candidate
r7_round 5 link_first 0.2 0.2 1.5 candidate
r7_round 6 tool_first 1.0 0.3 0   redeemed
r7_round 7 tool_first 0   1.0 0   redeemed
r7_round 8 link_first 0   0.5 1.0 redeemed
check "R7 the expected outcomes: tool first -> both portfolios at 10 queued for the note's 15; link first -> the new portfolio gets 15 promissory_note" \
  "$(q "SELECT public.r_desc_person('r7c_1') || ' | ' || public.r_desc_person('r7c_4')")" \
  "10|new|10|15,10|new|10|-,10|new|10|15 | 10|new|10|15,10|new|10|-,15|promissory_note|15|-"

# ===========================================================================
# Round 4. All of these run before R4/R3 (R3 resets the note windows).
echo "== R6b (round 4) the late link first (held), then a plain rate edit on the same portfolio: the gate's retry replaces the link's request (round 3: 23505)"
r6b_round() { # $1 = round, $2 = typed rate, $3 = how long the link is held (s); the edit starts 0.3 s after the link
  local i=$1 P PC m0 m1 mc0 mc1 e la ed
  P=$(q "SELECT public.t2_port('r8_$i', NULL, 'active')"); PC=$(q "SELECT public.t2_port('r8c_$i', NULL, 'active')")
  m0=$(q "$LATE_MAILS")
  bg a "BEGIN; $(LINK 0761 "$i" "r8_$i") SELECT pg_sleep($3); COMMIT; SELECT 'link committed at ' || clock_timestamp();"
  sleep 0.3; bg g "UPDATE public.investor_portfolios SET roi_percentage = $2 WHERE id = '$P'; SELECT 'edit done at ' || clock_timestamp();"; wait
  m1=$(q "$LATE_MAILS")
  mc0=$(q "$LATE_MAILS")
  q "$(LINK 0762 "$i" "r8c_$i")" >/dev/null; q "UPDATE public.investor_portfolios SET roi_percentage = $2 WHERE id = '$PC'" >/dev/null
  mc1=$(q "$LATE_MAILS")
  count_events "$OUT/a" "$OUT/g"
  e=$(errs "$OUT/a" "$OUT/g")
  la=$(tr -d '\r' < "$OUT/a" | sed -n 's/^link committed at //p'); ed=$(tr -d '\r' < "$OUT/g" | sed -n 's/^edit done at //p')
  check "R6b round $i (link held $3 s, edit to $2 0.3 s later): both commit, no error (no 23505), no deadlock; the edit ended after the link committed (it waited on the one-pending slot, then retried)" \
    "$(q "SELECT (partner_user_id IS NOT DISTINCT FROM public.pid('r8_$i'))::text FROM public.promissory_notes WHERE whatsapp_number = '0761$(printf %06d "$i")'")/${e:-none}/$(q "SELECT ('$ed'::timestamptz > '$la'::timestamptz)::text" 2>&1)" \
    "true/none/true"
  check "R6b round $i: same requests, rate in force, alert mails and r_missed as one after the other [$(q "SELECT public.r_hist('$PC')") / $(q "SELECT public.t_desc('$PC')") / $((mc1 - mc0)) mails / r_missed $(q "SELECT public.r_missed('r8c_$i')")]" \
    "$(q "SELECT public.r_hist('$P')")/$(q "SELECT public.t_desc('$P')")/$((m1 - m0))/$(q "SELECT public.r_missed('r8_$i')")" \
    "$(q "SELECT public.r_hist('$PC')")/$(q "SELECT public.t_desc('$PC')")/$((mc1 - mc0))/$(q "SELECT public.r_missed('r8c_$i')")"
}
r6b_round 1 12 1.0
r6b_round 2 18 1.0
r6b_round 3 12 1.5
r6b_round 4 18 1.5
r6b_round 5 12 0.6
check "R6b the expected outcomes (sequential controls): link then edit 12 -> the note's 15 superseded, 12 pending, the portfolio left below the note rate (r_missed 1, by design); edit 18 -> 18 pending (r_missed 0)" \
  "$(q "SELECT public.r_hist_person('r8c_1') || ' ' || public.r_missed('r8c_1') || ' | ' || public.r_hist_person('r8c_2') || ' ' || public.r_missed('r8c_2')")" \
  "note_late_link@15:superseded,rate_change@12:pending 1 | note_late_link@15:superseded,rate_change@18:pending 0"

echo "== R6d (round 5) another transaction holds a new pending request (15) for the portfolio while a plain rate edit runs: the edit's insert waits for it, inserts nothing once it commits (ON CONFLICT DO NOTHING), and the second try replaces it"
r6d_round() { # $1 = round, $2 = typed rate, $3 = how long the competitor holds (s); the edit starts 0.3 s after it
  local i=$1 P e cd ed
  P=$(q "SELECT public.t2_port('r14_$i', NULL, 'active')")
  q "SELECT setval('public._r_gate_try', 1, false)" >/dev/null
  bg c "BEGIN; INSERT INTO public.portfolio_rate_approvals (portfolio_id, requested_rate, rate_in_force, standard_rate, source) VALUES ('$P', 15, 10, 15, 'note_late_link'); SELECT pg_sleep($3); COMMIT; SELECT 'competitor committed at ' || clock_timestamp();"
  sleep 0.3; bg g "SELECT 'edit ' || public.r_try_edit('$P', $2); SELECT 'edit done at ' || clock_timestamp();" "-c t.count_try=$P"; wait
  count_events "$OUT/c" "$OUT/g"
  e=$(errs "$OUT/c" "$OUT/g")
  cd=$(tr -d '\r' < "$OUT/c" | sed -n 's/^competitor committed at //p'); ed=$(tr -d '\r' < "$OUT/g" | sed -n 's/^edit done at //p')
  check "R6d round $i (competitor held $3 s, edit to $2): the edit succeeds after the competitor committed, in 2 tries; the competitor's 15 superseded, $2 pending, the rate in force stays 10; no error, no deadlock" \
    "${e:-none}/$(tr -d '\r' < "$OUT/g" | grep -m1 '^edit ' | grep -v 'done at')/$(q "SELECT ('$ed'::timestamptz > '$cd'::timestamptz)::text" 2>&1)/$(q "SELECT public.r_gate_tries()")/$(q "SELECT public.r_hist('$P')")/$(q "SELECT public.t_desc('$P')")" \
    "none/edit ok/true/2/note_late_link@15:superseded,rate_change@$2:pending/10|new|10|$2"
}
r6d_round 1 12 1.0
r6d_round 2 18 1.0
r6d_round 3 12 0.6

echo "== R6e (round 5; round 6) the gate's second miss in a row: RAISE 23505 on portfolio_rate_approvals_one_pending (needs a test-only gap between the two tries)"
# c1 holds a pending 15 (R1) for P; the edit's first try waits for it and inserts nothing once c1 commits. In the gap before
# the second try the CFO decides R1 and c3 opens a pending 13 (R3) that it holds.
#  - CFO REJECTS R1 (rounds 1-4; round 6): R1 leaves the open set, c3's insert goes in; the second try supersedes nothing, its
#    insert waits for c3 and inserts nothing again -> the gate raises. Without the gap the second try runs the moment c1
#    commits, supersedes R1 and inserts: the CFO then finds nothing to decide and c3's insert fails on the edit's committed
#    pending request (a plain INSERT, as a direct write would; the first unique index it meets is one_pending).
#  - CFO APPROVES R1 (round 5 = the round-5 set-up; round 6): R1 is scheduled, so it stays in the one-open slot and c3's
#    insert is refused at once (one_open); the second try supersedes the scheduled R1 and inserts the 12 -> one open request,
#    which the CFO can approve. (Round 5 allowed c3's pending 13 beside the scheduled R1 and the gate raised.)
check "R6e set-up: the gate instrumented (test-only sleep before the second try, 0 unless a session sets t.gate_gap)" "$(q "SELECT public.r_gate_instrument(true)")" "instrumented"
r6e_round() { # $1 = round, $2 = gap | nogap, $3 = the CFO's decision on R1 (reject | approve)
  local i=$1 P R1 R3 e opts
  P=$(q "SELECT public.t2_port('r15_$i', NULL, 'active')")
  R1=$(printf 'eeeeeeee-0000-4000-8000-%012d' $((600 + i))); R3=$(printf 'eeeeeeee-0000-4000-8000-%012d' $((700 + i)))
  q "SELECT setval('public._r_gate_try', 1, false)" >/dev/null
  opts="-c t.count_try=$P"; [ "$2" = gap ] && opts="$opts -c t.gate_gap=1.5"
  bg c1 "BEGIN; INSERT INTO public.portfolio_rate_approvals (id, portfolio_id, requested_rate, rate_in_force, standard_rate, source) VALUES ('$R1', '$P', 15, 10, 15, 'note_late_link'); SELECT pg_sleep(1.0); COMMIT;"
  sleep 0.3; bg g "SELECT 'edit ' || public.r_try_edit('$P', 12);" "$opts"
  sleep 1.0; bg c "SELECT 'cfo decided ' || (public.cfo_decide_portfolio_rate_requests(ARRAY['$R1']::uuid[], '$3', 'race test') ->> 'decided');"
  sleep 0.3; bg c3 "BEGIN; INSERT INTO public.portfolio_rate_approvals (id, portfolio_id, requested_rate, rate_in_force, standard_rate, source) VALUES ('$R3', '$P', 13, 10, 13, 'rate_change'); SELECT pg_sleep(1.5); COMMIT; SELECT 'c3 committed';"
  wait
  count_events "$OUT/c1" "$OUT/g" "$OUT/c" "$OUT/c3"
  e="$(tr -d '\r' < "$OUT/g" | grep -m1 '^edit ') | $(tr -d '\r' < "$OUT/c" | grep -m1 -E 'ERROR|cfo decided' | cut -c1-60) | $(tr -d '\r' < "$OUT/c3" | grep -m1 -E 'ERROR|c3 committed' | cut -c1-120)"
  local got="$e/$(q "SELECT public.r_gate_tries()")/$(q "SELECT public.r_hist('$P')")/$(q "SELECT public.t_desc('$P')")/$(cat "$OUT/c1" "$OUT/g" "$OUT/c" "$OUT/c3" | grep -ci 'deadlock detected')"
  if [ "$2/$3" = gap/reject ]; then
    check "R6e round $i (gap, the CFO rejects R1): the edit fails with 23505 naming portfolio_rate_approvals_one_pending after 2 tries and is rolled back (R1 rejected, R3 pending, the rate in force 10); CFO decided 1; c3 committed; no deadlock" \
      "$got" \
      "edit 23505 portfolio_rate_approvals_one_pending: Another Returns rate request for this portfolio was opened at the same moment; try again | cfo decided 1 | c3 committed/2/note_late_link@15:rejected,rate_change@13:pending/10|new|10|13/0"
  elif [ "$2/$3" = nogap/reject ]; then
    check "R6e round $i (no gap, same sessions, the CFO rejects): one retry and the edit succeeds (R1 superseded, 12 pending); the CFO finds nothing to decide; c3's plain insert fails on the edit's pending 12; no deadlock" \
      "$got" \
      "edit ok | cfo decided 0 | ERROR:  duplicate key value violates unique constraint \"portfolio_rate_approvals_one_pending\"/2/note_late_link@15:superseded,rate_change@12:pending/10|new|10|12/0"
  else
    check "R6e round $i (round 6; gap, the CFO APPROVES R1 as in round 5): c3's insert is refused at once by one_open (R1 scheduled); the edit's second try supersedes the scheduled R1 and succeeds -> one open request, the 12; no deadlock" \
      "$got/open $(q "SELECT count(*) FROM public.portfolio_rate_approvals WHERE portfolio_id = '$P' AND (status = 'pending' OR (status = 'approved' AND applied_at IS NULL))")" \
      "edit ok | cfo decided 1 | ERROR:  duplicate key value violates unique constraint \"portfolio_rate_approvals_one_open\"/2/note_late_link@15:superseded,rate_change@12:pending/10|new|10|12/0/open 1"
    check "R6e round $i (round 6) ... and the CFO approves the edit's 12 (round 5: the gate raised and R1 stayed scheduled beside c3's pending 13)" \
      "$(q "SELECT public.cfo_decide_portfolio_rate_requests(ARRAY(SELECT id FROM public.portfolio_rate_approvals WHERE portfolio_id = '$P' AND status = 'pending'), 'approve', 'race test') ->> 'decided'" 2>&1 | tr '\n' ' ' | sed 's/ *$//' | cut -c1-120)" "1"
  fi
}
r6e_round 1 gap reject
r6e_round 2 gap reject
r6e_round 3 nogap reject
r6e_round 4 nogap reject
r6e_round 5 gap approve
r6e_round 6 gap approve
# R6f (round 6, counted; round-5 G13 / the gate's own S8c-like window): the gate's first try between its supersede and its
# insert (1.5 s, t.gate_gap1). c1 commits a pending 15 for P and the CFO approves it inside that gap. Round 5: the insert found
# no pending request and left the scheduled 15 beside its new pending 12, and the CFO's approval of the 12 then failed on
# portfolio_rate_approvals_one_scheduled. Round 6: the scheduled 15 is a conflict for one_open, so the first try inserts
# nothing and the second try supersedes the 15 and inserts the 12; one after the other the edit supersedes it too.
r6f_round() { # $1 = round; P = r15_<7+2i>, control PC = r15_<8+2i>
  local i=$1 P PC R1 R1C e
  P=$(q "SELECT public.t2_port('r15_$((7 + 2 * i))', NULL, 'active')"); PC=$(q "SELECT public.t2_port('r15_$((8 + 2 * i))', NULL, 'active')")
  R1=$(printf 'eeeeeeee-0000-4000-8000-%012d' $((607 + 2 * i))); R1C=$(printf 'eeeeeeee-0000-4000-8000-%012d' $((608 + 2 * i)))
  q "SELECT setval('public._r_gate_try', 1, false)" >/dev/null
  bg g "SELECT 'edit ' || public.r_try_edit('$P', 12);" "-c t.gate_gap1=1.5 -c t.count_try=$P"
  sleep 0.3; bg c1 "INSERT INTO public.portfolio_rate_approvals (id, portfolio_id, requested_rate, rate_in_force, standard_rate, source) VALUES ('$R1', '$P', 15, 10, 15, 'note_late_link'); SELECT 'c1 committed at ' || clock_timestamp();"
  sleep 0.3; bg c "SELECT 'cfo decided ' || (public.cfo_decide_portfolio_rate_requests(ARRAY['$R1']::uuid[], 'approve', 'race test') ->> 'decided'); SELECT 'cfo done at ' || clock_timestamp();"
  wait
  count_events "$OUT/g" "$OUT/c1" "$OUT/c"
  e=$(errs "$OUT/g" "$OUT/c1" "$OUT/c")
  q "INSERT INTO public.portfolio_rate_approvals (id, portfolio_id, requested_rate, rate_in_force, standard_rate, source) VALUES ('$R1C', '$PC', 15, 10, 15, 'note_late_link')" >/dev/null
  q "SELECT public.cfo_decide_portfolio_rate_requests(ARRAY['$R1C']::uuid[], 'approve', 'race test')" >/dev/null
  q "SELECT public.r_try_edit('$PC', 12)" >/dev/null
  check "R6f round $i (round 6, G13): no error, no deadlock; the CFO approved the 15 inside the gap (decided 1); the edit succeeds in 2 tries; the scheduled 15 superseded, the 12 pending -> one open request; same as one after the other [$(q "SELECT public.r_hist('$PC')")]" \
    "${e:-none}/$(tr -d '\r' < "$OUT/c" | grep -m1 -E 'ERROR|cfo decided')/$(tr -d '\r' < "$OUT/g" | grep -m1 '^edit ')/$(q "SELECT public.r_gate_tries()")/$(q "SELECT public.r_hist('$P')")/open $(q "SELECT count(*) FROM public.portfolio_rate_approvals WHERE portfolio_id = '$P' AND (status = 'pending' OR (status = 'approved' AND applied_at IS NULL))")" \
    "none/cfo decided 1/edit ok/2/$(q "SELECT public.r_hist('$PC')")/open 1"
  check "R6f round $i (round 6, G13) ... and the CFO approves the edit's 12: decided 1, no error (round 5: duplicate key on portfolio_rate_approvals_one_scheduled); the same for the control" \
    "$(q "SELECT public.cfo_decide_portfolio_rate_requests(ARRAY(SELECT id FROM public.portfolio_rate_approvals WHERE portfolio_id = '$P' AND status = 'pending'), 'approve', 'race test') ->> 'decided'" 2>&1 | tr '\n' ' ' | sed 's/ *$//' | cut -c1-120)/$(q "SELECT public.cfo_decide_portfolio_rate_requests(ARRAY(SELECT id FROM public.portfolio_rate_approvals WHERE portfolio_id = '$PC' AND status = 'pending'), 'approve', 'race test') ->> 'decided'" 2>&1 | tr '\n' ' ' | sed 's/ *$//' | cut -c1-120)/$(q "SELECT public.r_hist('$P')")" \
    "1/1/note_late_link@15:superseded,rate_change@12:approved"
}
r6f_round 1
r6f_round 2
check "R6f the expected outcome (control, one after the other): the scheduled 15 superseded by the edit's 12" \
  "$(q "SELECT public.r_hist(ip.id) FROM public.investor_portfolios ip WHERE ip.investor_id = public.pid('r15_10')")" "note_late_link@15:superseded,rate_change@12:approved"
check "R6e clean-up: the shipped gate text is back (md5 equal)" "$(q "SELECT public.r_gate_instrument(false)")" "restored"

echo "== R6c (round 4) two plain rate edits on one portfolio at the same time: the second waits for the first's row, then replaces its request"
for i in 1 2; do
  P=$(q "SELECT public.t2_port('r13_$i', NULL, 'active')")
  bg g "BEGIN; UPDATE public.investor_portfolios SET roi_percentage = 13 WHERE id = '$P'; SELECT pg_sleep(1.0); COMMIT;"
  sleep 0.3; bg h "UPDATE public.investor_portfolios SET roi_percentage = 12 WHERE id = '$P';"; wait
  count_events "$OUT/g" "$OUT/h"
  e=$(errs "$OUT/g" "$OUT/h")
  check "R6c round $i: both edits commit (no 23505, no deadlock); 13 superseded by the later 12; the rate in force stays 10" \
    "${e:-none}/$(q "SELECT public.r_hist('$P')")/$(q "SELECT public.t_desc('$P')")" "none/rate_change@12:pending,rate_change@13:superseded/10|new|10|12"
done

echo "== R8 (round 4; round 6) the CFO decides several requests while a plain rate edit replaces the open request of one of those portfolios"
# Round 6: a portfolio has at most ONE open request (portfolio_rate_approvals_one_open), so X's two requests are one open and one
# decided: 'pending' rounds -> X has a pending 12 (id 00000000-...) and a rejected 13 (id ffffffff-..., written first);
# 'scheduled' rounds -> X has a scheduled (approved, not applied) 13 (id ffffffff-..., written first) and a rejected 12
# (id 00000000-...). Y and Z a pending 12 each (queued by the gate). The CFO rejects all four ids (whatever is not pending is
# locked and skipped). Each updated request row sleeps 0.5 s in the session that goes first (t.apsleep), so it holds its locks.
# (Round 4 gave X a pending 12 AND a scheduled 13 at once; that set-up is now refused, checked first.)
r8_setup() { # $1 = person, $2 = id number, $3 = pending | scheduled -> sets X Y Z IDS
  X=$(q "SELECT public.t2_port('$1', NULL, 'active')"); Y=$(q "SELECT public.t2_port('$1', NULL, 'active')"); Z=$(q "SELECT public.t2_port('$1', NULL, 'active')")
  local hi lo; hi=$(printf 'ffffffff-0000-4000-8000-%012d' "$2"); lo=$(printf '00000000-0000-4000-8000-%012d' "$2")
  if [ "$3" = scheduled ]; then q "SELECT public.r_req('$hi', '$X', 13, 'approved'); SELECT public.r_req('$lo', '$X', 12, 'rejected');" >/dev/null
  else q "SELECT public.r_req('$hi', '$X', 13, 'rejected'); SELECT public.r_req('$lo', '$X', 12);" >/dev/null; fi
  q "UPDATE public.investor_portfolios SET roi_percentage = 12 WHERE id IN ('$Y', '$Z')" >/dev/null
  IDS="'$lo','$hi',$(q "SELECT string_agg(quote_literal(id::text), ',') FROM public.portfolio_rate_approvals WHERE portfolio_id IN ('$Y', '$Z') AND status = 'pending'")"
}
X0=$(q "SELECT public.t2_port('r9_9', NULL, 'active')")
check "R8 set-up (round 6): the round-4 set-up, a pending 12 beside a scheduled 13 on one portfolio, is now refused by portfolio_rate_approvals_one_open" \
  "$(q "SELECT public.r_req('ffffffff-0000-4000-8000-000000000199', '$X0', 13, 'approved')" 2>&1 | grep -m1 ERROR)$(q "SELECT public.r_req('00000000-0000-4000-8000-000000000199', '$X0', 12)" 2>&1 | grep -m1 ERROR | tr -d '\r')/$(q "SELECT public.r_hist('$X0')")" \
  "ERROR:  duplicate key value violates unique constraint \"portfolio_rate_approvals_one_open\"/rate_change@13:approved"
CFO="SELECT public.cfo_decide_portfolio_rate_requests(ARRAY[IDS]::uuid[], 'reject', 'race test') ->> 'decided'"
r8_round() { # $1 = round, $2 = cfo_first | edit_first, $3 = pending | scheduled (X's one open request)
  local i=$1 e out first XC YC ZC IDSC cres
  r8_setup "r9_$i" $((100 + i)) "$3"; local XT=$X YT=$Y ZT=$Z IDST=$IDS
  r8_setup "r9c_$i" $((200 + i)) "$3"; XC=$X; YC=$Y; ZC=$Z; IDSC=$IDS
  if [ "$2" = cfo_first ]; then
    bg c "BEGIN; ${CFO/IDS/$IDST}; COMMIT;" "-c t.apsleep=0.5"
    sleep 0.3; bg g "UPDATE public.investor_portfolios SET roi_percentage = 14 WHERE id = '$XT';"
  else
    bg g "BEGIN; UPDATE public.investor_portfolios SET roi_percentage = 14 WHERE id = '$XT'; SELECT pg_sleep(0.5); COMMIT;" "-c t.apsleep=0.5"
    sleep 0.3; bg c "${CFO/IDS/$IDST};"
  fi
  wait
  count_events "$OUT/c" "$OUT/g"
  e=$(errs "$OUT/c" "$OUT/g")
  cres=$(tr -d '\r' < "$OUT/c" | grep -m1 -E '^[0-9]+$')
  # The same two actions one after the other, in the order they ran.
  if [ "$2" = cfo_first ]; then q "${CFO/IDS/$IDSC}" > "$OUT/cc"; q "UPDATE public.investor_portfolios SET roi_percentage = 14 WHERE id = '$XC'" >/dev/null
  else q "UPDATE public.investor_portfolios SET roi_percentage = 14 WHERE id = '$XC'" >/dev/null; q "${CFO/IDS/$IDSC}" > "$OUT/cc"; fi
  check "R8 round $i ($2, X's open request $3): no deadlock, no error in either session" "$(cat "$OUT/c" "$OUT/g" | grep -ci 'deadlock detected')/${e:-none}" "0/none"
  check "R8 round $i ($2, $3): decided count, X, Y, Z equal the same two steps one after the other [$(tr -d '\r' < "$OUT/cc") | $(q "SELECT public.r_hist('$XC')") | $(q "SELECT public.r_hist('$YC')")]" \
    "$cres|$(q "SELECT public.r_hist('$XT')")|$(q "SELECT public.r_hist('$YT')")|$(q "SELECT public.r_hist('$ZT')")" \
    "$(tr -d '\r' < "$OUT/cc")|$(q "SELECT public.r_hist('$XC')")|$(q "SELECT public.r_hist('$YC')")|$(q "SELECT public.r_hist('$ZC')")"
}
r8_round 1 cfo_first pending
r8_round 2 edit_first pending
r8_round 3 cfo_first scheduled
r8_round 4 edit_first scheduled
check "R8 the expected outcomes (controls; round 6): X pending 12 -> CFO first: 3 decided, the 12 rejected, the edit's 14 pending; edit first: 2 decided, the 12 superseded, 14 pending. X scheduled 13 -> either order: 2 decided (the 13 locked and skipped), the 13 superseded by the edit's 14. Y and Z rejected every time; the decided count as printed" \
  "$(for k in 1 2 3 4; do echo -n "$(q "SELECT public.r_hist_person('r9c_$k')") | "; done)" \
  "rate_change@12:rejected,rate_change@13:rejected,rate_change@14:pending ; rate_change@12:rejected ; rate_change@12:rejected | rate_change@12:superseded,rate_change@13:rejected,rate_change@14:pending ; rate_change@12:rejected ; rate_change@12:rejected | rate_change@12:rejected,rate_change@13:superseded,rate_change@14:pending ; rate_change@12:rejected ; rate_change@12:rejected | rate_change@12:rejected,rate_change@13:superseded,rate_change@14:pending ; rate_change@12:rejected ; rate_change@12:rejected | "

# R8b (round 4, for the record; not counted in the deadlock total): ONE UPDATE changing the rate of TWO portfolios while the
# CFO batch decides their two requests. The gate locks each portfolio's requests in id order, but one row at a time, so a
# multi-row edit takes the two requests in row order. The first row's request gets the higher id, so the batch (id order)
# and the edit (row order) take them in opposite orders; the edit sleeps 1 s per request row it updates (t.apsleep).
X8=$(q "SELECT public.t2_port('r13_5', NULL, 'active')"); Y8=$(q "SELECT public.t2_port('r13_5', NULL, 'active')")
LO8=$X8; HI8=$Y8   # X8 is written first, so a sequential scan (the plan printed below) updates it first; it gets the higher request id
q "SELECT public.r_req('ffffffff-0000-4000-8000-000000000501', '$LO8', 12); SELECT public.r_req('00000000-0000-4000-8000-000000000501', '$HI8', 12);" >/dev/null
note "R8b plan of the two-row edit (rows in this order): $(q "EXPLAIN (COSTS OFF) UPDATE public.investor_portfolios SET roi_percentage = 14 WHERE id IN ('$X8', '$Y8')" | tr '\n' ' ' | cut -c1-200)"
bg g "UPDATE public.investor_portfolios SET roi_percentage = 14 WHERE id IN ('$X8', '$Y8'); SELECT 'edit ok';" "-c t.apsleep=1.0"
sleep 0.5; bg c "SELECT 'cfo decided ' || (public.cfo_decide_portfolio_rate_requests(ARRAY['00000000-0000-4000-8000-000000000501','ffffffff-0000-4000-8000-000000000501']::uuid[], 'reject', 'race test') ->> 'decided');"
wait
note "R8b a two-row rate edit vs the CFO batch: edit [$(tr -d '\r' < "$OUT/g" | grep -m1 -E 'ERROR|edit ok' | cut -c1-80)] CFO [$(tr -d '\r' < "$OUT/c" | grep -m1 -E 'ERROR|decided' | cut -c1-80)] first row [$(q "SELECT public.r_hist('$LO8')")] second row [$(q "SELECT public.r_hist('$HI8')")]"

check "R9-R11 set-up: the late-link trigger instrumented (test-only sleeps, 0 unless a session sets them)" "$(q "SELECT public.r_late_link_instrument(true)")" "instrumented"
echo "== R9 (round 4) the late link's round 2 meets a portfolio held FOR UPDATE by a split/lock tool that waits for the link's rate lock (round-3 S3 / x1)"
# T opens X for the person (the gate takes the rate lock) and commits after 1 s. L links the person's pre-cut-off note: it
# waits for T's rate lock, then sleeps 1.5 s before round 2 (t.r2gap). S, the split/lock tool pattern, locks X FOR UPDATE and
# opens a child of X for the same person (X is not live, so the gate takes the rate lock, held by L). Round 3: L's round 2
# waited for S (KEY SHARE) while S waited for L -> deadlock. Now round 2 skips X (SKIP LOCKED) and counts it in the alert.
r9_round() { # $1 = round, $2 = only_new (the person has no other portfolio) | with_earlier (one portfolio below the note rate already),
              # $3 = optional rate T types on X (18: X then already has a pending request above the note rate)
  local i=$1 mid e
  [ "$2" = with_earlier ] && q "SELECT public.t2_port('r10_$i', NULL, 'active')" >/dev/null
  mid=$(q "SELECT COALESCE(max(id), 0) FROM public._email_outbox")
  bg t "BEGIN; INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, duration_months, portfolio_pin, status)
        VALUES (public.pid('r10_$i'), public.pid('agent1'), 'R9X-$i', 100000, 12, '1111', 'pending_ops_approval');
        $([ -n "${3:-}" ] && echo "UPDATE public.investor_portfolios SET roi_percentage = $3 WHERE portfolio_code = 'R9X-$i';")
        SELECT pg_sleep(1.0); COMMIT; SELECT 'T committed at ' || clock_timestamp();"
  sleep 0.3
  bg a "UPDATE public.promissory_notes SET partner_user_id = public.pid('r10_$i') WHERE whatsapp_number = '0763$(printf %06d "$i")'; SELECT 'L committed at ' || clock_timestamp();" "-c t.r2gap=1.5"
  sleep 1.1
  bg s "BEGIN; SELECT 'S locked at ' || clock_timestamp() FROM public.investor_portfolios WHERE portfolio_code = 'R9X-$i' FOR UPDATE;
        INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, duration_months, portfolio_pin, status, locked_from_portfolio_id)
        SELECT public.pid('r10_$i'), public.pid('agent1'), 'R9C-$i', 100000, 12, '1111', 'pending_ops_approval', id FROM public.investor_portfolios WHERE portfolio_code = 'R9X-$i';
        COMMIT; SELECT 'S committed at ' || clock_timestamp();"
  wait
  count_events "$OUT/t" "$OUT/a" "$OUT/s"
  e=$(errs "$OUT/t" "$OUT/a" "$OUT/s")
  note "R9 round $i ($2): $(for f in t a s; do echo -n "[$f] $(tr -d '\r' < "$OUT/$f" | grep -E 'ERROR|committed|locked' | tr '\n' ' ' | cut -c1-200) "; done)"
  check "R9 round $i ($2): no deadlock, no error; the note is linked; S locked X before L's round 2 ran (the window was hit) and S committed after L" \
    "${e:-none}/$(q "SELECT (partner_user_id IS NOT DISTINCT FROM public.pid('r10_$i'))::text FROM public.promissory_notes WHERE whatsapp_number = '0763$(printf %06d "$i")'")/$(q "SELECT ('$(tr -d '\r' < "$OUT/s" | sed -n 's/^S locked at //p')'::timestamptz < '$(tr -d '\r' < "$OUT/a" | sed -n 's/^L committed at //p')'::timestamptz AND '$(tr -d '\r' < "$OUT/s" | sed -n 's/^S committed at //p')'::timestamptz > '$(tr -d '\r' < "$OUT/a" | sed -n 's/^L committed at //p')'::timestamptz)::text" 2>&1)" \
    "none/true/true"
  if [ -n "${3:-}" ]; then
    # Round 5 (round-4 P2-4b): X is skipped as busy but already has an open request at or above the note rate -> not counted.
    check "R9 round $i ($2, X already has a pending $3; round 5, P2-4b): X keeps its $3 and gets no note request, the child got 15, r_missed 0, and NO 'needs a check' alert (as one after the other)" \
      "$(q "SELECT public.r_desc_person('r10_$i')")/$(q "SELECT public.r_missed('r10_$i')")/$(q "SELECT public.r_late_mail($mid)")" \
      "10|new|10|$3,15|promissory_note|15|-/0/0:- :: -"
  elif [ "$2" = only_new ]; then
    check "R9 round $i ($2): X skipped (busy) and left at 10 with no request; the tool's child got the note's 15; the alert counts X, subject 'needs a check' (nothing queued)" \
      "$(q "SELECT public.r_desc_person('r10_$i')")/$(q "SELECT public.r_missed('r10_$i')")/$(q "SELECT public.r_late_mail($mid)")" \
      "10|new|10|-,15|promissory_note|15|-/1/2:Promissory note linked late: Returns catch-up needs a check :: 1 portfolio(s) could not be queued because another change to the same portfolio was in progress at the same moment. Check them in the CFO queue against the promissory note's rate."
  else
    check "R9 round $i ($2): the earlier portfolio queued at 15, X skipped (busy, counted), the child got 15; usual subject, both sentences" \
      "$(q "SELECT public.r_desc_person('r10_$i')")/$(q "SELECT public.r_missed('r10_$i')")/$(q "SELECT public.r_late_mail($mid)")" \
      "10|new|10|15,10|new|10|-,15|promissory_note|15|-/1/2:Promissory note linked late: Returns catch-up waiting for the CFO :: 1 portfolio(s) of 1 partner(s) were opened inside a promissory note's window at a lower rate, before the note was linked to them. Each is waiting in the CFO queue (source note_late_link); nothing changes until the CFO approves. 1 portfolio(s) could not be queued because another change to the same portfolio was in progress at the same moment. Check them in the CFO queue against the promissory note's rate."
  fi
}
r9_round 1 only_new
r9_round 2 with_earlier
r9_round 3 only_new
r9_round 4 with_earlier
r9_round 5 only_new 18

echo "== R10 (round 4) the late link supersedes two lower requests of its person while the CFO decides them (round-3 S4)"
# r11_<i> has two portfolios with a pending 12 each; the lower portfolio's request has id ffffffff-..., the higher one's
# 00000000-... (so scan order and id order differ). The first session sleeps 1 s per request row it updates (t.apsleep).
r10_round() { # $1 = round, $2 = link_first | cfo_first
  local i=$1 X1 X2 C1 C2 LO HI LOC HIC e cres ccres m0 m1 mc0 mc1
  X1=$(q "SELECT public.t2_port('r11_$i', NULL, 'active')"); X2=$(q "SELECT public.t2_port('r11_$i', NULL, 'active')")
  LO=$(q "SELECT least('$X1'::uuid, '$X2'::uuid)"); HI=$(q "SELECT greatest('$X1'::uuid, '$X2'::uuid)")
  C1=$(q "SELECT public.t2_port('r11c_$i', NULL, 'active')"); C2=$(q "SELECT public.t2_port('r11c_$i', NULL, 'active')")
  LOC=$(q "SELECT least('$C1'::uuid, '$C2'::uuid)"); HIC=$(q "SELECT greatest('$C1'::uuid, '$C2'::uuid)")
  local a1 a2 c1 c2
  a1=$(printf 'ffffffff-0000-4000-8000-%012d' $((300 + i))); a2=$(printf '00000000-0000-4000-8000-%012d' $((300 + i)))
  c1=$(printf 'ffffffff-0000-4000-8000-%012d' $((400 + i))); c2=$(printf '00000000-0000-4000-8000-%012d' $((400 + i)))
  q "SELECT public.r_req('$a1', '$LO', 12); SELECT public.r_req('$a2', '$HI', 12); SELECT public.r_req('$c1', '$LOC', 12); SELECT public.r_req('$c2', '$HIC', 12);" >/dev/null
  m0=$(q "$LATE_MAILS")
  if [ "$2" = link_first ]; then
    bg l "BEGIN; $(LINK 0764 "$i" "r11_$i") COMMIT;" "-c t.apsleep=1.0"
    sleep 0.5; bg c "SELECT public.cfo_decide_portfolio_rate_requests(ARRAY['$a2','$a1']::uuid[], 'approve', 'race test') ->> 'decided';"
  else
    bg c "BEGIN; SELECT public.cfo_decide_portfolio_rate_requests(ARRAY['$a2','$a1']::uuid[], 'approve', 'race test') ->> 'decided'; COMMIT;" "-c t.apsleep=1.0"
    sleep 0.5; bg l "BEGIN; $(LINK 0764 "$i" "r11_$i") COMMIT;"
  fi
  wait
  m1=$(q "$LATE_MAILS")
  count_events "$OUT/l" "$OUT/c"
  e=$(errs "$OUT/l" "$OUT/c")
  cres=$(tr -d '\r' < "$OUT/c" | grep -m1 -E '^[0-9]+$')
  mc0=$(q "$LATE_MAILS")
  if [ "$2" = link_first ]; then q "$(LINK 0765 "$i" "r11c_$i")" >/dev/null; ccres=$(q "SELECT public.cfo_decide_portfolio_rate_requests(ARRAY['$c2','$c1']::uuid[], 'approve', 'race test') ->> 'decided'")
  else ccres=$(q "SELECT public.cfo_decide_portfolio_rate_requests(ARRAY['$c2','$c1']::uuid[], 'approve', 'race test') ->> 'decided'"); q "$(LINK 0765 "$i" "r11c_$i")" >/dev/null; fi
  mc1=$(q "$LATE_MAILS")
  check "R10 round $i ($2): no deadlock, no error; the note is linked" \
    "$(cat "$OUT/l" "$OUT/c" | grep -ci 'deadlock detected')/${e:-none}/$(q "SELECT (partner_user_id IS NOT DISTINCT FROM public.pid('r11_$i'))::text FROM public.promissory_notes WHERE whatsapp_number = '0764$(printf %06d "$i")'")" "0/none/true"
  check "R10 round $i ($2): CFO decided count, both portfolios' requests and alert mails equal the two steps one after the other [$ccres | $(q "SELECT public.r_hist('$LOC')") | $(q "SELECT public.r_hist('$HIC')") | $((mc1 - mc0))]" \
    "$cres|$(q "SELECT public.r_hist('$LO')")|$(q "SELECT public.r_hist('$HI')")|$((m1 - m0))" \
    "$ccres|$(q "SELECT public.r_hist('$LOC')")|$(q "SELECT public.r_hist('$HIC')")|$((mc1 - mc0))"
}
r10_round 1 link_first
r10_round 2 cfo_first
r10_round 3 link_first
r10_round 4 cfo_first
check "R10 the expected outcomes (controls): link first -> both 12s superseded, both 15 pending, the CFO decides nothing; CFO first -> both 12s approved then superseded by the link's 15" \
  "$(q "SELECT public.r_hist_person('r11c_1')") | $(q "SELECT public.r_hist_person('r11c_2')")" \
  "note_late_link@15:pending,rate_change@12:superseded ; note_late_link@15:pending,rate_change@12:superseded | note_late_link@15:pending,rate_change@12:superseded ; note_late_link@15:pending,rate_change@12:superseded"

echo "== R11 (round 4) a staff request committing inside the late link's step 2, between its look-up and its supersede (round-3 S8; gap widened 1.5 s, t.gap)"
r11_round() { # $1 = round, $2 = staff rate (18: at or above the note's 15; 12: below)
  local i=$1 P PC m0 m1 mc0 mc1 e
  P=$(q "SELECT public.t2_port('r12_$i', NULL, 'active')"); PC=$(q "SELECT public.t2_port('r12c_$i', NULL, 'active')")
  m0=$(q "$LATE_MAILS")
  bg l "BEGIN; $(LINK 0766 "$i" "r12_$i") COMMIT;" "-c t.gap=1.5"
  sleep 0.6; bg s "UPDATE public.investor_portfolios SET roi_percentage = $2 WHERE id = '$P'; SELECT 'staff committed at ' || clock_timestamp();"
  wait
  m1=$(q "$LATE_MAILS")
  count_events "$OUT/l" "$OUT/s"
  e=$(errs "$OUT/l" "$OUT/s")
  # Equivalent order: the staff request committed before the link wrote anything, so: staff first, then the link.
  mc0=$(q "$LATE_MAILS"); q "UPDATE public.investor_portfolios SET roi_percentage = $2 WHERE id = '$PC'" >/dev/null; q "$(LINK 0767 "$i" "r12c_$i")" >/dev/null; mc1=$(q "$LATE_MAILS")
  check "R11 round $i (staff asks $2 inside the gap): both commit, no error, no deadlock" \
    "${e:-none}/$(q "SELECT (partner_user_id IS NOT DISTINCT FROM public.pid('r12_$i'))::text FROM public.promissory_notes WHERE whatsapp_number = '0766$(printf %06d "$i")'")" "none/true"
  check "R11 round $i (staff asks $2): requests, alert mails and r_missed equal 'staff first, then the link' [$(q "SELECT public.r_hist('$PC')") / $((mc1 - mc0)) mails]" \
    "$(q "SELECT public.r_hist('$P')")/$((m1 - m0))/$(q "SELECT public.r_missed('r12_$i')")" "$(q "SELECT public.r_hist('$PC')")/$((mc1 - mc0))/$(q "SELECT public.r_missed('r12c_$i')")"
}
r11_round 1 18
r11_round 2 12
r11_round 3 18
check "R11 the expected outcomes: a request at or above the note rate (18) stands, no note request, no alert; a lower one (12) is superseded by the note's 15 with an alert" \
  "$(q "SELECT public.r_hist_person('r12c_1') || ' ' || public.r_missed('r12c_1') || ' | ' || public.r_hist_person('r12c_2') || ' ' || public.r_missed('r12c_2')")" \
  "rate_change@18:pending 0 | note_late_link@15:pending,rate_change@12:superseded 0"
echo "== R11c (round 5, round-4 S8c) a staff 18 is committed AND approved by the CFO inside the late link's step-2 gap (1.5 s, t.gap)"
r11c_round() { # $1 = round
  local i=$1 P PC m0 m1 mc0 mc1 e ca la
  P=$(q "SELECT public.t2_port('r16_$i', NULL, 'active')"); PC=$(q "SELECT public.t2_port('r16c_$i', NULL, 'active')")
  m0=$(q "$LATE_MAILS")
  bg l "BEGIN; $(LINK 0768 "$i" "r16_$i") COMMIT; SELECT 'link committed at ' || clock_timestamp();" "-c t.gap=1.5"
  sleep 0.6; bg s "UPDATE public.investor_portfolios SET roi_percentage = 18 WHERE id = '$P';"
  sleep 0.4; bg c "SELECT 'cfo decided ' || (public.cfo_decide_portfolio_rate_requests(ARRAY(SELECT id FROM public.portfolio_rate_approvals WHERE portfolio_id = '$P' AND status = 'pending'), 'approve', 'race test') ->> 'decided'); SELECT 'cfo done at ' || clock_timestamp();"
  wait
  m1=$(q "$LATE_MAILS")
  count_events "$OUT/l" "$OUT/s" "$OUT/c"
  e=$(errs "$OUT/l" "$OUT/s" "$OUT/c")
  ca=$(tr -d '\r' < "$OUT/c" | sed -n 's/^cfo done at //p'); la=$(tr -d '\r' < "$OUT/l" | sed -n 's/^link committed at //p')
  # Equivalent order: the staff 18 and its approval committed before the link wrote anything.
  mc0=$(q "$LATE_MAILS")
  q "UPDATE public.investor_portfolios SET roi_percentage = 18 WHERE id = '$PC'" >/dev/null
  q "SELECT public.cfo_decide_portfolio_rate_requests(ARRAY(SELECT id FROM public.portfolio_rate_approvals WHERE portfolio_id = '$PC' AND status = 'pending'), 'approve', 'race test')" >/dev/null
  q "$(LINK 0769 "$i" "r16c_$i")" >/dev/null
  mc1=$(q "$LATE_MAILS")
  check "R11c round $i: no error, no deadlock; the note is linked; the CFO approved the 18 (decided 1) before the link committed (inside the gap)" \
    "${e:-none}/$(q "SELECT (partner_user_id IS NOT DISTINCT FROM public.pid('r16_$i'))::text FROM public.promissory_notes WHERE whatsapp_number = '0768$(printf %06d "$i")'")/$(tr -d '\r' < "$OUT/c" | grep -m1 'cfo decided')/$(q "SELECT ('$ca'::timestamptz < '$la'::timestamptz)::text" 2>&1)" \
    "none/true/cfo decided 1/true"
  check "R11c round $i: no pending note request beside the scheduled 18 (round 4: a pending 15 that the CFO could not approve), no alert, r_missed 0 -- the same as 'staff 18 approved, then the link' [$(q "SELECT public.r_hist('$PC')") / $((mc1 - mc0)) mails]" \
    "$(q "SELECT public.r_hist('$P')")/$((m1 - m0))/$(q "SELECT public.r_missed('r16_$i')")" "$(q "SELECT public.r_hist('$PC')")/$((mc1 - mc0))/$(q "SELECT public.r_missed('r16c_$i')")"
}
r11c_round 1
r11c_round 2
check "R11c the expected outcome (control): rate_change 18 approved (scheduled, not applied), no note_late_link request, no alert" \
  "$(q "SELECT public.r_hist_person('r16c_1') || ' ' || (SELECT count(*) FROM public.portfolio_rate_approvals a JOIN public.investor_portfolios ip ON ip.id = a.portfolio_id WHERE ip.investor_id = public.pid('r16c_1') AND a.status = 'approved' AND a.applied_at IS NULL)")" \
  "rate_change@18:approved 1"
echo "== R11d (round 6, round-5 S8d) a lower staff 12 is committed AND approved by the CFO between the late link's step-2 supersede and its insert (2.0 s, t.gap3)"
# Round 5: the link's insert found no pending request (the 12 was scheduled), so it left a pending note 15 beside the scheduled
# 12 and the CFO's approval of the 15 failed on portfolio_rate_approvals_one_scheduled. Round 6: the scheduled 12 is a conflict
# for one_open, so pass 1 inserts nothing; pass 2 sees the 12 (below the note rate), supersedes it and queues the 15.
r11d_round() { # $1 = round
  local i=$1 P PC m0 m1 mc0 mc1 e ca la
  P=$(q "SELECT public.t2_port('r17_$i', NULL, 'active')"); PC=$(q "SELECT public.t2_port('r17c_$i', NULL, 'active')")
  m0=$(q "$LATE_MAILS")
  bg l "BEGIN; $(LINK 0770 "$i" "r17_$i") COMMIT; SELECT 'link committed at ' || clock_timestamp();" "-c t.gap3=2.0"
  sleep 0.6; bg s "UPDATE public.investor_portfolios SET roi_percentage = 12 WHERE id = '$P'; SELECT 'staff committed at ' || clock_timestamp();"
  sleep 0.5; bg c "SELECT 'cfo decided ' || (public.cfo_decide_portfolio_rate_requests(ARRAY(SELECT id FROM public.portfolio_rate_approvals WHERE portfolio_id = '$P' AND status = 'pending'), 'approve', 'race test') ->> 'decided'); SELECT 'cfo done at ' || clock_timestamp();"
  wait
  m1=$(q "$LATE_MAILS")
  count_events "$OUT/l" "$OUT/s" "$OUT/c"
  e=$(errs "$OUT/l" "$OUT/s" "$OUT/c")
  ca=$(tr -d '\r' < "$OUT/c" | sed -n 's/^cfo done at //p'); la=$(tr -d '\r' < "$OUT/l" | sed -n 's/^link committed at //p')
  # Equivalent order: the staff 12 and its approval committed before the link wrote anything.
  mc0=$(q "$LATE_MAILS")
  q "UPDATE public.investor_portfolios SET roi_percentage = 12 WHERE id = '$PC'" >/dev/null
  q "SELECT public.cfo_decide_portfolio_rate_requests(ARRAY(SELECT id FROM public.portfolio_rate_approvals WHERE portfolio_id = '$PC' AND status = 'pending'), 'approve', 'race test')" >/dev/null
  q "$(LINK 0771 "$i" "r17c_$i")" >/dev/null
  mc1=$(q "$LATE_MAILS")
  check "R11d round $i: no error, no deadlock; the note is linked; the staff 12 committed and the CFO approved it (decided 1) before the link committed (inside the gap)" \
    "${e:-none}/$(q "SELECT (partner_user_id IS NOT DISTINCT FROM public.pid('r17_$i'))::text FROM public.promissory_notes WHERE whatsapp_number = '0770$(printf %06d "$i")'")/$(tr -d '\r' < "$OUT/c" | grep -m1 'cfo decided')/$(q "SELECT ('$ca'::timestamptz < '$la'::timestamptz)::text" 2>&1)" \
    "none/true/cfo decided 1/true"
  check "R11d round $i: one open request, the note's 15 (the scheduled 12 superseded); one alert pair; r_missed 0 -- the same as 'staff 12 approved, then the link' [$(q "SELECT public.r_hist('$PC')") / $((mc1 - mc0)) mails]" \
    "$(q "SELECT public.r_hist('$P')")/open $(q "SELECT count(*) FROM public.portfolio_rate_approvals WHERE portfolio_id = '$P' AND (status = 'pending' OR (status = 'approved' AND applied_at IS NULL))")/$((m1 - m0))/$(q "SELECT public.r_missed('r17_$i')")" \
    "$(q "SELECT public.r_hist('$PC')")/open 1/$((mc1 - mc0))/$(q "SELECT public.r_missed('r17c_$i')")"
  check "R11d round $i ... and the CFO approves the note's 15: decided 1, no error (round 5: duplicate key on portfolio_rate_approvals_one_scheduled)" \
    "$(q "SELECT public.cfo_decide_portfolio_rate_requests(ARRAY(SELECT id FROM public.portfolio_rate_approvals WHERE portfolio_id = '$P' AND status = 'pending'), 'approve', 'race test') ->> 'decided'" 2>&1 | tr '\n' ' ' | sed 's/ *$//' | cut -c1-120)" "1"
}
r11d_round 1
r11d_round 2
check "R11d the expected outcome (control): the scheduled 12 superseded by the note's 15 (pending), r_missed 0" \
  "$(q "SELECT public.r_hist_person('r17c_1') || ' ' || public.r_missed('r17c_1')")" "note_late_link@15:pending,rate_change@12:superseded 0"
check "R9-R11 clean-up: the shipped late-link trigger text is back (md5 equal)" "$(q "SELECT public.r_late_link_instrument(false)")" "restored"

echo "== R12 (round 6, a) auto_explain of the shipped gate's and late link's nested INSERT ... ON CONFLICT (one transaction, rolled back)"
# The plans of the statements as they run inside the triggers (auto_explain.log_nested_statements, sent to the client as
# NOTICE): r17_9 opens a portfolio, a plain edit to 12 (the gate's insert), then the person is linked late (the link supersedes
# the 12 and inserts the note's 15).
"$PSQL" -h localhost -p "$PORT" -U postgres -d postgres -X -q -At \
  -c "LOAD 'auto_explain'; SET auto_explain.log_min_duration = 0; SET auto_explain.log_nested_statements = on; SET auto_explain.log_level = notice; SET client_min_messages = notice;" \
  -c "BEGIN; SELECT public.t2_port('r17_9', NULL, 'active') IS NOT NULL; UPDATE public.investor_portfolios SET roi_percentage = 12 WHERE investor_id = public.pid('r17_9'); $(LINK 0770 9 r17_9) SELECT 'R12 requests ' || public.r_hist_person('r17_9'); ROLLBACK;" \
  > "$OUT/r12" 2>&1
tr -d '\r' < "$OUT/r12" | awk '/Query Text:/ { q = $0; src = "" } /rate_change.?, auth\.uid\(\)/ { src = "gate" } /.note_late_link., auth\.uid\(\)/ { src = "late_link" } /Conflict Arbiter Indexes: .*portfolio_rate_approvals/ { sub(/^.*Conflict Arbiter Indexes: */, ""); print (src == "" ? "?" : src) "=" $0 }' > "$OUT/r12_arbiters"
check "R12 (round 6, a) the nested INSERTs' conflict arbiters, as executed: the gate's and the late link's each name one_pending AND one_open; the run queued the 12 and then the note's 15" \
  "$(tr '\n' ' ' < "$OUT/r12_arbiters")/$(tr -d '\r' < "$OUT/r12" | grep -m1 '^R12 requests' )" \
  "gate=portfolio_rate_approvals_one_pending, portfolio_rate_approvals_one_open late_link=portfolio_rate_approvals_one_pending, portfolio_rate_approvals_one_open /R12 requests note_late_link@15:pending,rate_change@12:superseded"

# ===========================================================================
echo "== R4 split bookings over overlapping houses at the same time (each house reservation slowed to 300 ms)"
PAY='{"partner_name":"Race Split","whatsapp_number":"0784000001"}'
D0=$deadlocks
r4_round() { # $1 = case, $2 = round
  local H1 H2 H3 L1 L2 before
  H1=$(q "SELECT public.t2_house(100000)"); H2=$(q "SELECT public.t2_house(110000)"); H3=$(q "SELECT public.t2_house(120000)")
  case $1 in
    same_order)     L1="'$H1','$H2'"; L2="'$H2','$H3'";;
    identical)      L1="'$H1','$H2'"; L2="'$H1','$H2'";;
    opposite_order) L1="'$H1','$H2'"; L2="'$H2','$H1'";;
  esac
  before=$(q "SELECT count(*) FROM public.promissory_notes")
  bg a "SELECT jsonb_array_length(public.agent_create_promissory_notes_split('$PAY'::jsonb, ARRAY[$L1]::uuid[]) -> 'notes');" "-c request.jwt.claim.sub=$AGENT -c t.slow=on"
  [ "$1" = opposite_order ] || sleep 0.1
  bg b "SELECT jsonb_array_length(public.agent_create_promissory_notes_split('$PAY'::jsonb, ARRAY[$L2]::uuid[]) -> 'notes');" "-c request.jwt.claim.sub=$AGENT -c t.slow=on"
  wait
  count_events "$OUT/a" "$OUT/b"
  local okA okB; okA=$(tr -d '\r' < "$OUT/a" | grep -cx 2); okB=$(tr -d '\r' < "$OUT/b" | grep -cx 2)
  check "R4 $1 round $2: exactly one booking succeeds" "$((okA + okB))" "1"
  check "R4 $1 round $2: the loser left nothing (notes = 2 more, each house reserved once at most)" \
    "$(( $(q "SELECT count(*) FROM public.promissory_notes") - before ))/$(q "SELECT COALESCE(max(c), 0) FROM (SELECT count(*) c FROM public.promissory_note_house_intents WHERE house_id IN ('$H1','$H2','$H3') AND status = 'reserved' GROUP BY house_id) x")" "2/1"
  local le; le=$(cat "$OUT/a" "$OUT/b" | tr -d '\r' | grep -m1 ERROR | cut -c1-160)
  check "R4 $1 round $2: the loser is told HOUSES_UNAVAILABLE (no raw unique violation, no deadlock)" \
    "$(echo "$le" | grep -c 'ERROR:  HOUSES_UNAVAILABLE')" "1"
  note "R4 $1 round $2: loser's error: $le"
}
for r in 1 2 3; do r4_round same_order $r; done
for r in 1 2 3; do r4_round identical $r; done
for r in 1 2 3 4 5 6; do r4_round opposite_order $r; done
check "R4 no deadlock in any split round (houses are booked in house-id order)" "$((deadlocks - D0))" "0"
check "R4 notes come back in the order the screen sent the houses" \
  "$(PGOPTIONS="-c request.jwt.claim.sub=$AGENT" q "SELECT string_agg((n -> 'note' ->> 'amount'), ',' ORDER BY o) FROM jsonb_array_elements(public.agent_create_promissory_notes_split('{\"partner_name\":\"Order\",\"whatsapp_number\":\"0784000002\"}'::jsonb, ARRAY[public.t2_house(130000), public.t2_house(70000), public.t2_house(99000)]) -> 'notes') WITH ORDINALITY AS e(n, o)" 2>&1)" "130000,70000,99000"

# ===========================================================================
echo "== R3 the CEO switches on while every creation path is running (4 sessions x 12 calls; 150 ms between"
echo "   writing the commitment and inserting the portfolio, so calls straddle the switch-on)"
r3_round() { # $1 = round
  local r=$1 k j p
  q "SELECT public.r_reset_never_on()" >/dev/null
  for k in 1 2 3 4; do
    : > "$OUT/w$k.sql"
    for j in $(seq 1 12); do
      p=$(( (r * 100 + k * 13 + j) % 40 + 1 ))
      case $(( (k + j) % 5 )) in
        0) echo "SELECT public.t2_fcpp('r3_new$p');" ;;
        1) echo "SELECT public.t2_psm('r3_ex$p');" ;;
        2) echo "SELECT public.t2_psh4('r3_new$p');" ;;
        3) echo "SELECT public.t2_cpp('r3_ex$p');" ;;
        4) echo "SELECT public.t2_psh4('r3_emp$(( p % 10 + 1 ))');" ;;
      esac >> "$OUT/w$k.sql"
      echo "SELECT pg_sleep(0.02) IS NULL AS x \\gset" >> "$OUT/w$k.sql"
    done
  done
  local T0; T0=$(q "SELECT clock_timestamp()")
  for k in 1 2 3 4; do
    ( PGOPTIONS="-c t.slow_commit=on" "$PSQL" -h localhost -p "$PORT" -U postgres -d postgres -X -q -At -f "$OUT/w$k.sql" > "$OUT/w$k.out" 2>&1 ) &
  done
  sleep 0.$(( 3 + r * 2 ))
  bg s "SELECT (public.set_partner_return_policy(true) ->> 'changed')"
  wait
  count_events "$OUT"/w*.out "$OUT/s"
  local e; e=$(errs "$OUT"/w*.out "$OUT/s")
  check "R3 round $r: switch on (cut-off set, list frozen), every creation call succeeded" \
    "$(tr -d '\r' < "$OUT/s")/$(q "SELECT (cutoff_at > '$T0')::text FROM public.partner_return_policy")/$(cat "$OUT"/w*.out | tr -d '\r' | grep -c -E '^[0-9a-f-]{36}$')/${e:-none}" "true/true/48/none"
  local CUTR; CUTR=$(q "SELECT cutoff_at FROM public.partner_return_policy")
  check "R3 round $r: before/after split [$(q "SELECT count(*) FILTER (WHERE rate_decided_at < '$CUTR') || ' before, ' || count(*) FILTER (WHERE rate_decided_at >= '$CUTR') || ' after' FROM public.investor_portfolios WHERE rate_decided_at >= '$T0'")]: before = switch_off 15, after = the person's rate (never switch_off)" \
    "$(q "SELECT count(*) FROM public.investor_portfolios WHERE rate_decided_at >= '$T0' AND ((rate_decided_at < '$CUTR' AND (rate_basis <> 'switch_off' OR roi_percentage <> 15)) OR (rate_decided_at >= '$CUTR' AND rate_basis IN ('switch_off', 'typed_switch_off')))")" "0"
  check "R3 round $r: the switch-on landed mid-run (portfolios on both sides of the cut-off)" \
    "$(q "SELECT (count(*) FILTER (WHERE rate_decided_at < '$CUTR') > 0 AND count(*) FILTER (WHERE rate_decided_at >= '$CUTR') > 0)::text FROM public.investor_portfolios WHERE rate_decided_at >= '$T0'")" "true"
  note "R3 round $r: calls whose commitment was written before the cut-off and portfolio after it (the reconcile path): $(q "SELECT count(*) FROM public.investor_portfolios ip JOIN public.funder_pending_portfolios f ON f.portfolio_id = ip.id JOIN public.partner_self_commitments c ON c.id = f.commitment_id WHERE ip.rate_decided_at >= '$CUTR' AND c.created_at < '$CUTR' AND ip.rate_decided_at >= '$T0'"); of those, rate moved from 15: $(q "SELECT count(*) FROM public.investor_portfolios ip JOIN public.funder_pending_portfolios f ON f.portfolio_id = ip.id JOIN public.partner_self_commitments c ON c.id = f.commitment_id WHERE ip.rate_decided_at >= '$CUTR' AND c.created_at < '$CUTR' AND ip.rate_decided_at >= '$T0' AND ip.roi_percentage <> 15")"
  check "R3 round $r: every new portfolio's commitment / lines / houses equal its stored rate" "$(q "SELECT public.r_children_mismatch('$T0')")" "0"
  check "R3 round $r: every rate stored this round prints without trailing zeros" \
    "$(q "SELECT regexp_replace(public.t2_raw_since('$T0'), '/[0-9]+', '', 'g')")" "p:0 c:0 l:0 h:0"
  check "R3 round $r: conformance empty" "$(q "SELECT count(*) FROM public.partner_rate_conformance(NULL)")" "0"
  check "R3 round $r: no portfolio decided before the cut-off is missing from the frozen lists (cohort = live holders before the cut-off)" \
    "$(q "SELECT count(*) FROM (SELECT ip.investor_id FROM public.investor_portfolios ip WHERE ip.status IN ('active','locked') AND ip.rate_decided_at < '$CUTR' GROUP BY 1 EXCEPT SELECT partner_id FROM public.partner_return_cohort) d")" "0"
}
for r in 1 2 3; do r3_round $r; done

echo "== R3b a creation transaction held open for 4 s across the switch-on (the switch-on waits at most 0.5 s; Phase 6 F5)"
q "SELECT public.r_reset_never_on()" >/dev/null
bg w "BEGIN; SELECT public.t2_fcpp('r3_new1'); SELECT pg_sleep(4); COMMIT;"
sleep 0.4
bg s "SELECT (public.set_partner_return_policy(true) ->> 'changed')"
wait
count_events "$OUT/w" "$OUT/s"
check "R3b switch-on gives up after 0.5 s with 'Partner Returns was not switched on' (55P03; nothing half-on), the slow creation commits at 15 (stored as 15, not 15.00)" \
  "$(grep -c 'Partner Returns was not switched on: portfolios are being updated right now' "$OUT/s")/$(q "SELECT enabled || '/' || COALESCE(cutoff_at::text, 'none') FROM public.partner_return_policy")/$(q "SELECT roi_percentage::text || '|' || rate_basis FROM public.investor_portfolios WHERE investor_id = public.pid('r3_new1') ORDER BY rate_decided_at DESC LIMIT 1")" \
  "1/false/none/15|switch_off"
check "R3b retried switch-on succeeds" "$(q "SELECT (public.set_partner_return_policy(true) ->> 'changed')")" "true"

echo "RACE deadlocks seen: $deadlocks; lock timeouts seen: $timeouts (R3b's refusal is a 55P03 'not switched on', not counted here)"
echo "RACE SUMMARY $pass passed, $fail failed"
