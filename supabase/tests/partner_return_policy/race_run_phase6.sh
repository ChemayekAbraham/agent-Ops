#!/usr/bin/env bash
# Phase 6 F2 concurrency: a bulk late link (one UPDATE linking the notes of thousands of people, as a profile phone or
# email backfill does) holds a partner-rate lock only for people whose linked note has an OPEN pre-cut-off window. It
# must not block portfolio creation for anyone else while it is open. Control: a link that does take a lock (a
# pre-cut-off note with an open window, contact proven) blocks a portfolio insert for THAT person (lock_timeout), and
# not for a person in another bucket.
# Prerequisite: a fresh run_phase4_tests.sh load of $PGDB (switch never on). THROWAWAY local Postgres (port 55432) only.
PSQL="${PSQL:-C:/Program Files/PostgreSQL/18/bin/psql.exe}"
PORT="${PORT:-55432}"
PGDB="${PGDB:-postgres}"
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/out_race_phase6"; rm -rf "$OUT"; mkdir -p "$OUT"
q()  { "$PSQL" -h localhost -p "$PORT" -U postgres -d "$PGDB" -X -q -At -v ON_ERROR_STOP=1 -c "$1" 2>&1 | tr -d '\r'; }
bg() { "$PSQL" -h localhost -p "$PORT" -U postgres -d "$PGDB" -X -q -At -c "$2" > "$OUT/$1" 2>&1 & }
pass=0; fail=0
check() { if [ "$2" == "$3" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1  got [$2] want [$3]"; fail=$((fail+1)); fi; }
note()  { echo "INFO  $*"; }
# Insert a portfolio for $1 with lock_timeout 1s; prints ok:<ms> or the error, ms measured inside the session.
ins() {
  q "SET lock_timeout = '1s';
     DO \$x\$ DECLARE t0 timestamptz := clock_timestamp(); BEGIN
       INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, status, duration_months, portfolio_pin)
       VALUES (public.pid('$1'), public.pid('agent1'), 'F2-' || '$1' || '-' || floor(random() * 1e9)::text, 100000, 'active', 12, '1111');
       RAISE NOTICE 'T_INS ok:%', round(extract(epoch FROM clock_timestamp() - t0) * 1000);
     EXCEPTION WHEN lock_not_available THEN RAISE NOTICE 'T_INS lock_timeout:%', round(extract(epoch FROM clock_timestamp() - t0) * 1000);
     END \$x\$;" | grep -o 'T_INS [a-z_]*:[0-9]*' | cut -c7-
}
status() { echo "${1%%:*}"; }
ms()     { echo "${1##*:}"; }

# Set-up: a pre-cut-off note for w1's phone (unlinked), then the first switch-on (owner session, release_ready as the
# Phase 7 release sets it), then 3,000 notes written after the cut-off (no window), unlinked.
q "INSERT INTO auth.users (id, email) VALUES (public.pid('f2_w1'), 'f2w1@test') ON CONFLICT DO NOTHING;
   INSERT INTO public.promissory_notes (agent_id, partner_name, whatsapp_number, amount, status, fulfilment_due_on)
   VALUES (public.pid('agent1'), 'F2 Window', '+256709990001', 1000000, 'pending', current_date + 10);
   UPDATE public.partner_return_policy SET release_ready = true;
   UPDATE public.partner_return_policy SET enabled = true;" >/dev/null
check "F2 set-up: switch on, the pre-cut-off note has an open frozen window" \
  "$(q "SELECT p.enabled || '/' || (SELECT count(*) FROM public.partner_return_note_windows w JOIN public.promissory_notes n ON n.id = w.note_id WHERE n.partner_name = 'F2 Window' AND w.ends_on >= current_date) FROM public.partner_return_policy p")" "true/1"
q "INSERT INTO public.promissory_notes (agent_id, partner_name, whatsapp_number, amount, status, fulfilment_due_on)
   SELECT public.pid('agent1'), 'F2 Bulk ' || i, '+25670888' || lpad(i::text, 4, '0'), 1000, 'pending', current_date + 5 FROM generate_series(1, 3000) i;" >/dev/null
W1B=$(q "SELECT hashtext(public.pid('f2_w1')::text) & 255")
U1=$(q "SELECT 'f2_u' || i FROM generate_series(1, 50) i WHERE hashtext(public.pid('f2_u' || i)::text) & 255 <> $W1B ORDER BY i LIMIT 1")
note "w1 bucket $W1B; unrelated person $U1 bucket $(q "SELECT hashtext(public.pid('$U1')::text) & 255"); the 3,000 bulk people cover $(q "SELECT count(DISTINCT hashtext(public.pid('f2_bulk_' || i)::text) & 255) FROM generate_series(1, 3000) i") of 256 buckets"

# A: one UPDATE links the 3,000 post-cut-off notes, then holds its transaction open for 3 s.
bg a "BEGIN; UPDATE public.promissory_notes n SET partner_user_id = public.pid('f2_bulk_' || ltrim(substr(n.whatsapp_number, 10), '0'))
        WHERE n.partner_name LIKE 'F2 Bulk %' AND n.partner_user_id IS NULL;
      SELECT 'A_LOCKS ' || count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid();
      SELECT pg_sleep(3); COMMIT;"
sleep 1
R1=$(ins "$U1"); R2=$(ins "f2_bulk_17")
wait
check "F2 while a bulk link of 3,000 post-cut-off notes is open: the link holds no advisory lock" "$(grep -o 'A_LOCKS [0-9]*' "$OUT/a")" "A_LOCKS 0"
check "F2 ... an unrelated person's portfolio insert is not blocked (lock_timeout 1s; under 900 ms)" \
  "$(status "$R1")/$(( $(ms "$R1") < 900 ))" "ok/1"
check "F2 ... nor a portfolio insert for one of the people being linked (their notes have no window)" \
  "$(status "$R2")/$(( $(ms "$R2") < 900 ))" "ok/1"
check "F2 ... the bulk link committed: 3,000 notes linked, no error" \
  "$(q "SELECT count(*) FROM public.promissory_notes WHERE partner_name LIKE 'F2 Bulk %' AND partner_user_id IS NOT NULL")/$(grep -ci error "$OUT/a")" "3000/0"
note "F2 insert times while the bulk link was open: unrelated $(ms "$R1") ms, linked person $(ms "$R2") ms"

# Control: a pre-cut-off note with an OPEN window, the note's phone proven by w1 (OTP login), linked and held open.
q "INSERT INTO public.otp_login_audit (phone, resolved_user_id, outcome) VALUES ('+256709990001', public.pid('f2_w1'), 'success')" >/dev/null
bg b "BEGIN; UPDATE public.promissory_notes SET partner_user_id = public.pid('f2_w1') WHERE partner_name = 'F2 Window';
      SELECT 'B_LOCKS ' || count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid();
      SELECT pg_sleep(3); COMMIT;"
sleep 1
R3=$(ins "f2_w1"); R4=$(ins "$U1")
wait
check "F2 control: linking a pre-cut-off note with an open window (contact proven) holds exactly one rate lock" "$(grep -o 'B_LOCKS [0-9]*' "$OUT/b")" "B_LOCKS 1"
check "F2 control: ... a portfolio insert for THAT person waits for the link (lock_timeout 1s reached)" "$(status "$R3")" "lock_timeout"
check "F2 control: ... a person in another bucket is not blocked (under 900 ms)" "$(status "$R4")/$(( $(ms "$R4") < 900 ))" "ok/1"
check "F2 control: the windowed link committed (linked to w1, not held), no error" \
  "$(q "SELECT (partner_user_id = public.pid('f2_w1'))::text FROM public.promissory_notes WHERE partner_name = 'F2 Window'")/$(grep -ci error "$OUT/b")" "true/0"
check "F2 after both links: conformance empty, assert all ok" \
  "$(q "SELECT count(*) FROM public.partner_rate_conformance(NULL)")/$(q "SELECT COALESCE(string_agg(check_name, ','), 'all ok') FROM public.assert_partner_return_policy_intact() WHERE NOT ok")" "0/all ok"

# ---------------------------------------------------------------------------------------------------------------------
# Phase 6 G1: the gate waits at most 3 s for a held rate-lock bucket (never longer than the caller's own lock_timeout),
# then refuses with a retryable 55P03 and a clear message; the caller's lock_timeout is put back. A holder session
# takes the bucket of g1_x (as a bulk note link would) and keeps it; creations in other buckets are not affected.
# ins2 <person> <lock_timeout|-> [invite <code>]: one creation in its own session. Prints
#   ok:<ms>:<lock_timeout after>   or   err:<ms>:<sqlstate>:<message>|<hint>
ins2() {
  local set=""; [ "$2" != "-" ] && set="SET lock_timeout = '$2';"
  local stmt="INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, status, duration_months, portfolio_pin)
              VALUES (public.pid('$1'), public.pid('agent1'), 'G1-' || '$1' || '-' || floor(random() * 1e9)::text, 100000, 'active', 12, '1111');"
  if [ "${3:-}" = invite ]; then
    stmt="UPDATE public.investor_portfolios SET investor_id = public.pid('$1') WHERE portfolio_code = '$4';"
  fi
  q "$set
     DO \$x\$ DECLARE t0 timestamptz := clock_timestamp(); v_st text; v_m text; v_h text; BEGIN
       $stmt
       RAISE NOTICE 'T_G1 ok:%:%', round(extract(epoch FROM clock_timestamp() - t0) * 1000), current_setting('lock_timeout');
     EXCEPTION WHEN others THEN
       GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_m = MESSAGE_TEXT, v_h = PG_EXCEPTION_HINT;
       RAISE NOTICE 'T_G1 err:%:%:%|%', round(extract(epoch FROM clock_timestamp() - t0) * 1000), v_st, v_m, v_h;
     END \$x\$;" | grep -o 'T_G1 .*' | cut -c6-
}
f1() { echo "$1" | cut -d: -f1; }
f2() { echo "$1" | cut -d: -f2; }
f3() { echo "$1" | cut -d: -f3-; }
G1MSG="The portfolio was not saved: this partner's Returns rate is being updated by another change right now. Nothing was changed; try again in a minute.|A bulk note link or contact backfill holds the rate lock; it is released when that change finishes."
q "INSERT INTO auth.users (id, email) VALUES (public.pid('g1_x'), 'g1x@test') ON CONFLICT DO NOTHING" >/dev/null
GXB=$(q "SELECT hashtext(public.pid('g1_x')::text) & 255")
GY=$(q "SELECT 'g1_y' || i FROM generate_series(1, 50) i WHERE hashtext(public.pid('g1_y' || i)::text) & 255 <> $GXB ORDER BY i LIMIT 1")
# An invite opened while on (no investor), to be claimed by g1_x while the bucket is held.
q "INSERT INTO public.investor_portfolios (investor_id, invite_id, agent_id, portfolio_code, investment_amount, status, duration_months, portfolio_pin)
   VALUES (NULL, gen_random_uuid(), public.pid('agent1'), 'G1-INV', 100000, 'active', 12, '1111')" >/dev/null
note "G1 held person g1_x bucket $GXB; other person $GY bucket $(q "SELECT hashtext(public.pid('$GY')::text) & 255")"

# Normal creations, nothing held: fast, the caller's lock_timeout comes back unchanged (7s, 0, 500ms).
N1=$(ins2 "$GY" 7s); N2=$(ins2 "$GY" -); N3=$(ins2 "$GY" 500ms)
check "G1 nothing held: creations succeed fast (under 900 ms); lock_timeout after = the caller's own (7s / 0 / 500ms)" \
  "$(f1 "$N1")/$(( $(f2 "$N1") < 900 ))/$(f3 "$N1") $(f1 "$N2")/$(( $(f2 "$N2") < 900 ))/$(f3 "$N2") $(f1 "$N3")/$(( $(f2 "$N3") < 900 ))/$(f3 "$N3")" \
  "ok/1/7s ok/1/0 ok/1/500ms"

# Holder: the bucket of g1_x, kept for 14 s.
bg g1hold "BEGIN; SELECT public.partner_rate_lock(ARRAY[public.pid('g1_x')]);
           SELECT 'G1_HELD ' || count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid();
           SELECT pg_sleep(14); COMMIT;"
sleep 1
H1=$(ins2 g1_x -)          # caller has no lock_timeout (0): capped at 3 s
H2=$(ins2 g1_x 10s)        # caller's 10s is longer: capped at 3 s
H3=$(ins2 g1_x 1s)         # caller's 1s is shorter: kept
H4=$(ins2 "$GY" 7s)        # another bucket: not affected
H5=$(ins2 g1_x - invite G1-INV)   # invite claim by g1_x: capped at 3 s
wait
check "G1 holder took exactly one rate-lock bucket" "$(grep -o 'G1_HELD [0-9]*' "$OUT/g1hold")" "G1_HELD 1"
check "G1 held bucket, caller lock_timeout 0: refused 55P03 within 2.5-4.5 s with the retry message and hint" \
  "$(f1 "$H1")/$(( $(f2 "$H1") >= 2500 && $(f2 "$H1") < 4500 ))/$(echo "$H1" | cut -d: -f3)/$(echo "$H1" | cut -d: -f4-)" "err/1/55P03/$G1MSG"
check "G1 held bucket, caller lock_timeout 10s: refused 55P03 within 2.5-4.5 s (capped at 3 s)" \
  "$(f1 "$H2")/$(( $(f2 "$H2") >= 2500 && $(f2 "$H2") < 4500 ))/$(echo "$H2" | cut -d: -f3)" "err/1/55P03"
check "G1 held bucket, caller lock_timeout 1s: refused 55P03 within 0.8-2.0 s (the shorter caller value kept)" \
  "$(f1 "$H3")/$(( $(f2 "$H3") >= 800 && $(f2 "$H3") < 2000 ))/$(echo "$H3" | cut -d: -f3)" "err/1/55P03"
check "G1 held bucket: a creation for a person in another bucket succeeds fast; lock_timeout after 7s" \
  "$(f1 "$H4")/$(( $(f2 "$H4") < 900 ))/$(f3 "$H4")" "ok/1/7s"
check "G1 held bucket: an invite claim by the held person is refused 55P03 within 2.5-4.5 s with the retry message" \
  "$(f1 "$H5")/$(( $(f2 "$H5") >= 2500 && $(f2 "$H5") < 4500 ))/$(echo "$H5" | cut -d: -f3)/$(echo "$H5" | cut -d: -f4-)" "err/1/55P03/$G1MSG"
check "G1 nothing was saved for g1_x (no portfolio, the invite still unclaimed)" \
  "$(q "SELECT count(*) FROM public.investor_portfolios WHERE investor_id = public.pid('g1_x')")/$(q "SELECT (investor_id IS NULL)::text FROM public.investor_portfolios WHERE portfolio_code = 'G1-INV'")" "0/true"
note "G1 refusal times: cap0 $(f2 "$H1") ms, cap10s $(f2 "$H2") ms, caller1s $(f2 "$H3") ms, invite claim $(f2 "$H5") ms; other bucket $(f2 "$H4") ms"

# Switch off after the cut-off: the off-period insert takes the lock too (G2 stamp) and is bounded the same way.
q "UPDATE public.partner_return_policy SET enabled = false" >/dev/null
bg g1hold2 "BEGIN; SELECT public.partner_rate_lock(ARRAY[public.pid('g1_x')]); SELECT pg_sleep(6); COMMIT;"
sleep 1
O1=$(ins2 g1_x -); O2=$(ins2 "$GY" -)
wait
check "G1 switch off after the cut-off, held bucket: refused 55P03 within 2.5-4.5 s; another bucket ok fast (lock_timeout after 0)" \
  "$(f1 "$O1")/$(( $(f2 "$O1") >= 2500 && $(f2 "$O1") < 4500 ))/$(echo "$O1" | cut -d: -f3) $(f1 "$O2")/$(( $(f2 "$O2") < 900 ))/$(f3 "$O2")" "err/1/55P03 ok/1/0"
# After the holders are gone: the same creations go through (retry works), switch back on.
R1G=$(ins2 g1_x -)
q "UPDATE public.partner_return_policy SET enabled = true" >/dev/null
R2G=$(ins2 g1_x - invite G1-INV)
check "G1 retry after the holder committed: off-period insert ok (15 switch_off, flag false), then (on) the invite claim ok (10 new, flag false)" \
  "$(f1 "$R1G")/$(f1 "$R2G")/$(q "SELECT string_agg(trim_scale(roi_percentage) || '|' || rate_basis || '|' || COALESCE(rate_existing_at_decision::text, 'null'), ',' ORDER BY portfolio_code DESC) FROM public.investor_portfolios WHERE investor_id = public.pid('g1_x')")" \
  "ok/ok/15|switch_off|false,10|new|false"
check "G1 after all: conformance empty, assert all ok" \
  "$(q "SELECT count(*) FROM public.partner_rate_conformance(NULL)")/$(q "SELECT COALESCE(string_agg(check_name, ','), 'all ok') FROM public.assert_partner_return_policy_intact() WHERE NOT ok")" "0/all ok"

echo "RACE PHASE6 SUMMARY $pass passed, $fail failed"
