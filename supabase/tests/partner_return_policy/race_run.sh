#!/usr/bin/env bash
# Race tests for Phase 1 (per-person Partner Returns) against a THROWAWAY local Postgres (port 55432).
# Prerequisite: race_stub.sql, then the Phase 1 migration, loaded (run_phase1_tests.sh does this).
# Never point this at production: reset() disables guards and truncates tables.
PSQL="${PSQL:-C:/Program Files/PostgreSQL/18/bin/psql.exe}"
PORT="${PORT:-55432}"
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/out_race"; rm -rf "$OUT"; mkdir -p "$OUT"
q()    { "$PSQL" -h localhost -p "$PORT" -U postgres -d postgres -X -q -At -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
qas()  { local who="$1"; shift; PGOPTIONS="-c request.jwt.claim.sub=$who" "$PSQL" -h localhost -p "$PORT" -U postgres -d postgres -X -q -At -c "$1" | tr -d '\r'; }
qf()   { "$PSQL" -h localhost -p "$PORT" -U postgres -d postgres -X -q -At -f "$1"; }
CFO=$(q "SELECT public.pid('cfo')"); CEO=$(q "SELECT public.pid('ceo')")
qcfo() { qas "$CFO" "$1"; }
qceo() { qas "$CEO" "$1"; }
pass=0; fail=0
check() { # name, actual, expected
  if [ "$2" == "$3" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1  got [$2] want [$3]"; fail=$((fail+1)); fi
}
errs() { grep -hiE "error|deadlock" "$OUT"/* 2>/dev/null | grep -v "^$" | head -5; }
nerrs() { grep -hiE "error|deadlock" "$OUT"/* 2>/dev/null | grep -vc "^$"; }

q "CREATE TABLE IF NOT EXISTS public._race_marks (k text, at timestamptz NOT NULL DEFAULT clock_timestamp());
   CREATE OR REPLACE FUNCTION public.r_new(p_person text, p_rate numeric DEFAULT NULL, p_status text DEFAULT 'active') RETURNS uuid
   LANGUAGE sql VOLATILE AS \$\$
     INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, status, roi_percentage)
     VALUES (public.pid(p_person), public.pid('agent1'), 'R-' || p_person, 100000, p_status, p_rate) RETURNING id \$\$;" >/dev/null

reset() { # back to 'never switched on': guards disabled only for the reset itself
  q "ALTER TABLE public.partner_return_policy DISABLE TRIGGER trg_partner_return_policy_guard;
     UPDATE public.partner_return_policy SET enabled = false, cutoff_at = NULL, enabled_at = NULL, existing_partner_mode = 'own', existing_partner_cap = NULL, release_ready = true;
     ALTER TABLE public.partner_return_policy ENABLE TRIGGER trg_partner_return_policy_guard;
     ALTER TABLE public.partner_return_cohort DISABLE TRIGGER USER;
     TRUNCATE public.partner_return_cohort;
     ALTER TABLE public.partner_return_cohort ENABLE TRIGGER USER;
     ALTER TABLE public.partner_return_note_windows DISABLE TRIGGER USER;
     TRUNCATE public.partner_return_note_windows;
     ALTER TABLE public.partner_return_note_windows ENABLE TRIGGER USER;
     ALTER TABLE public.partner_return_legacy_portfolios DISABLE TRIGGER USER;
     TRUNCATE public.partner_return_legacy_portfolios;
     ALTER TABLE public.partner_return_legacy_portfolios ENABLE TRIGGER USER;
     TRUNCATE public.portfolio_rate_approvals, public.investor_portfolios, public.audit_logs, public.pending_wallet_operations,
              public._email_outbox, public.system_events, public.hr_staff, public.partner_agreements, public._race_marks;" >/dev/null
  rm -f "$OUT"/*
}
on()  { q "SELECT public.set_partner_return_policy(true)" >/dev/null; }    # database-owner session (allowed)
off() { q "SELECT public.set_partner_return_policy(false)" >/dev/null; }
newp() { q "INSERT INTO public.investor_portfolios (portfolio_code, roi_percentage) VALUES ('$1', ${2:-15}) RETURNING id"; }

# Population used by the switch-on races (all decided while the switch is off).
seed_population() {
  q "DO \$\$ BEGIN
       FOR i IN 1..5 LOOP
         PERFORM public.r_new('e20_' || i, 20); PERFORM public.r_new('e14_' || i, 14);
         INSERT INTO public.hr_staff (user_id, active) VALUES (public.pid('emp_' || i), true);
       END LOOP;
       FOR i IN 1..20 LOOP PERFORM public.r_new('h_' || i, (ARRAY[10,14,15,20])[1 + i % 4], CASE WHEN i % 5 = 0 THEN 'locked' ELSE 'active' END); END LOOP;
       FOR i IN 1..5 LOOP PERFORM public.r_new('gone_' || i, 15, 'redeemed'); PERFORM public.r_new('wait_' || i, 15, 'pending_ops_approval'); END LOOP;
       FOR i IN 1..3 LOOP INSERT INTO public.partner_agreements (partner_id, partner_signature_data_url) VALUES (public.pid('sig_' || i), 'data:x'); END LOOP;
       INSERT INTO public.partner_agreements (partner_id, partner_signature_data_url) VALUES (public.pid('e20_1'), 'data:x');
     END \$\$;" >/dev/null
}
# Cohort vs. what was live (and decided) before the cut-off, plus signed agreements without a live portfolio.
COHORT_DIFF="SELECT count(*) FROM (
  (SELECT partner_id, basis, live_portfolios, min_rate, max_rate FROM public.partner_return_cohort
   EXCEPT
   (SELECT ip.investor_id, 'live_portfolio', count(*)::int, min(ip.roi_percentage), max(ip.roi_percentage)
      FROM public.investor_portfolios ip, public.partner_return_policy p
     WHERE ip.status IN ('active','locked') AND ip.investor_id IS NOT NULL AND ip.rate_decided_at < p.cutoff_at GROUP BY ip.investor_id
    UNION ALL
    SELECT pa.partner_id, 'signed_agreement', 0, NULL, NULL FROM public.partner_agreements pa, public.partner_return_policy p
     WHERE pa.partner_signature_data_url IS NOT NULL AND pa.countersigned_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.investor_portfolios ip WHERE ip.investor_id = pa.partner_id AND ip.status IN ('active','locked') AND ip.rate_decided_at < p.cutoff_at)))
  UNION ALL
  ((SELECT ip.investor_id, 'live_portfolio', count(*)::int, min(ip.roi_percentage), max(ip.roi_percentage)
      FROM public.investor_portfolios ip, public.partner_return_policy p
     WHERE ip.status IN ('active','locked') AND ip.investor_id IS NOT NULL AND ip.rate_decided_at < p.cutoff_at GROUP BY ip.investor_id
    UNION ALL
    SELECT pa.partner_id, 'signed_agreement', 0, NULL, NULL FROM public.partner_agreements pa, public.partner_return_policy p
     WHERE pa.partner_signature_data_url IS NOT NULL AND pa.countersigned_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.investor_portfolios ip WHERE ip.investor_id = pa.partner_id AND ip.status IN ('active','locked') AND ip.rate_decided_at < p.cutoff_at))
   EXCEPT
   SELECT partner_id, basis, live_portfolios, min_rate, max_rate FROM public.partner_return_cohort)) d"

# ===========================================================================
# CFO queue races (unchanged semantics from the per-contract version)
# ===========================================================================
echo "== R1 two CFO approvals of the same request at the same time"
for i in 1 2 3 4 5; do
  reset; P=$(newp R1 15); on
  q "UPDATE public.investor_portfolios SET roi_percentage = 20 WHERE id = '$P'"
  R=$(q "SELECT id FROM public.portfolio_rate_approvals WHERE status = 'pending'")
  qcfo "BEGIN; SELECT public.cfo_decide_portfolio_rate_requests(ARRAY['$R']::uuid[], 'approve', 'a'); SELECT pg_sleep(0.3); COMMIT;" > "$OUT/a" 2>&1 &
  qcfo "BEGIN; SELECT public.cfo_decide_portfolio_rate_requests(ARRAY['$R']::uuid[], 'approve', 'b'); SELECT pg_sleep(0.3); COMMIT;" > "$OUT/b" 2>&1 &
  wait
  check "R1.$i approved once, rate waits for next cycle" "$(q "SELECT roi_percentage::int || '/' || (SELECT count(*) FROM public.portfolio_rate_approvals WHERE status='approved') || '/' || (SELECT count(*) FROM public.audit_logs WHERE action_type LIKE 'cfo_%')  FROM public.investor_portfolios WHERE id='$P'")" "15/1/1"
  check "R1.$i one session decided, one skipped" "$(cat "$OUT/a" "$OUT/b" | grep -o '"decided": [0-9]' | sort | tr '\n' ' ')" '"decided": 0 "decided": 1 '
  [ -n "$(errs)" ] && { echo "      errors: $(errs)"; fail=$((fail+1)); }
done

echo "== R2 CFO approval racing a staff rate edit (both orders), no deadlock"
for order in edit_first approve_first; do
  reset; P=$(newp R2 15); on
  q "UPDATE public.investor_portfolios SET roi_percentage = 20 WHERE id = '$P'"
  R=$(q "SELECT id FROM public.portfolio_rate_approvals WHERE status = 'pending'")
  EDIT="BEGIN; UPDATE public.investor_portfolios SET roi_percentage = 25 WHERE id = '$P'; SELECT pg_sleep(0.5); COMMIT;"
  APPR="BEGIN; SELECT public.cfo_decide_portfolio_rate_requests(ARRAY['$R']::uuid[], 'approve', 'x'); SELECT pg_sleep(0.5); COMMIT;"
  if [ $order == edit_first ]; then
    qcfo "$EDIT" > "$OUT/a" 2>&1 & sleep 0.15; qcfo "$APPR" > "$OUT/b" 2>&1 & wait
  else
    qcfo "$APPR" > "$OUT/a" 2>&1 & sleep 0.15; qcfo "$EDIT" > "$OUT/b" 2>&1 & wait
  fi
  check "R2 $order" "$(q "SELECT roi_percentage::int || '|' || string_agg(a.status || ':' || a.requested_rate::int || '@' || a.rate_in_force::int, ',' ORDER BY a.requested_at) FROM public.investor_portfolios ip JOIN public.portfolio_rate_approvals a ON a.portfolio_id = ip.id WHERE ip.id='$P' GROUP BY ip.roi_percentage")" "15|superseded:20@15,pending:25@15"
  [ -n "$(errs)" ] && { echo "      errors: $(errs)"; fail=$((fail+1)); }
done

echo "== R3 two CFO batches over the same requests in opposite order (deadlock check), 10 rounds"
for i in $(seq 1 10); do
  reset; P1=$(newp A 15); P2=$(newp B 15); on
  q "UPDATE public.investor_portfolios SET roi_percentage = 20 WHERE id IN ('$P1','$P2')"
  R1=$(q "SELECT id FROM public.portfolio_rate_approvals WHERE portfolio_id='$P1' AND status='pending'")
  R2=$(q "SELECT id FROM public.portfolio_rate_approvals WHERE portfolio_id='$P2' AND status='pending'")
  qcfo "BEGIN; SELECT public.cfo_decide_portfolio_rate_requests(ARRAY['$R1','$R2']::uuid[], 'approve', 'a'); SELECT pg_sleep(0.2); COMMIT;" > "$OUT/a" 2>&1 &
  qcfo "BEGIN; SELECT public.cfo_decide_portfolio_rate_requests(ARRAY['$R2','$R1']::uuid[], 'approve', 'b'); SELECT pg_sleep(0.2); COMMIT;" > "$OUT/b" 2>&1 &
  wait
  check "R3.$i both approved once (rate waits), no deadlock" "$(q "SELECT count(*) FILTER (WHERE roi_percentage = 15) || '/' || (SELECT count(*) FROM public.portfolio_rate_approvals WHERE status='approved') FROM public.investor_portfolios")/$(nerrs)" "2/2/0"
done

echo "== R4 two staff edits on one portfolio at once"
reset; P=$(newp R4 15); on
qcfo "BEGIN; UPDATE public.investor_portfolios SET roi_percentage = 21 WHERE id='$P'; SELECT pg_sleep(0.4); COMMIT;" > "$OUT/a" 2>&1 &
sleep 0.1
qcfo "BEGIN; UPDATE public.investor_portfolios SET roi_percentage = 22 WHERE id='$P'; SELECT pg_sleep(0.1); COMMIT;" > "$OUT/b" 2>&1 &
wait
check "R4 one pending (the later edit), rate unchanged" "$(q "SELECT roi_percentage::int || '|' || (SELECT string_agg(status || ':' || requested_rate::int, ',' ORDER BY requested_at) FROM public.portfolio_rate_approvals) FROM public.investor_portfolios WHERE id='$P'")/$(nerrs)" "15|superseded:21,pending:22/0"

echo "== R5 switch flipped ON/OFF 12 times (CEO) while portfolios are being created one by one"
reset
for i in $(seq 1 400); do echo "INSERT INTO public.investor_portfolios (portfolio_code, roi_percentage) VALUES ('R5-$i', 15); SELECT pg_sleep(0.008);"; done > "$OUT/r5.sql"
qf "$OUT/r5.sql" > "$OUT/a.log" 2>&1 &
sleep 0.2
FIRSTCUT=""
for k in $(seq 1 12); do
  qceo "SELECT public.set_partner_return_policy(true)" >/dev/null; [ -z "$FIRSTCUT" ] && FIRSTCUT=$(q "SELECT cutoff_at FROM public.partner_return_policy")
  sleep 0.12; qceo "SELECT public.set_partner_return_policy(false)" >/dev/null; sleep 0.12
done
wait
check "R5 every row consistent (15 typed_switch_off & no request, or 10 new_no_investor & one pending 15)" "$(q "SELECT count(*) FILTER (WHERE NOT ((ip.roi_percentage = 15 AND ip.rate_basis = 'typed_switch_off' AND a.id IS NULL) OR (ip.roi_percentage = 10 AND ip.rate_basis = 'new_no_investor' AND a.status = 'pending' AND a.requested_rate = 15))) FROM public.investor_portfolios ip LEFT JOIN public.portfolio_rate_approvals a ON a.portfolio_id = ip.id")" "0"
check "R5 the cut-off never moved after the first ON (24 flips)" "$(q "SELECT (cutoff_at = '$FIRSTCUT'::timestamptz)::text || '/' || (SELECT count(*) FROM public.audit_logs WHERE action_type = 'set_partner_return_policy') FROM public.partner_return_policy")" "true/24"
echo "      mix: $(q "SELECT string_agg(r || 'x' || n, ' ') FROM (SELECT roi_percentage::int r, count(*) n FROM public.investor_portfolios GROUP BY 1 ORDER BY 1) s") (both rates expected); errors: $(nerrs)"

echo "== R6 four sessions creating 150 portfolios each at a typed 20% (no investor)"
reset; on
for s in 1 2 3 4; do
  q "DO \$\$ BEGIN FOR i IN 1..150 LOOP INSERT INTO public.investor_portfolios (portfolio_code, roi_percentage) VALUES ('R6-$s-' || i, 20); END LOOP; END \$\$;" > "$OUT/s$s" 2>&1 &
done
wait
check "R6 600 portfolios at 10, 600 pending requests, no errors" "$(q "SELECT count(*) FILTER (WHERE roi_percentage = 10) || '/' || (SELECT count(*) FROM public.portfolio_rate_approvals WHERE status='pending') FROM public.investor_portfolios")/$(nerrs)" "600/600/0"

echo "== R7 a failed or rolled-back insert leaves no orphan request"
reset; on
q "BEGIN; INSERT INTO public.investor_portfolios (portfolio_code, roi_percentage) VALUES ('R7a', 20); ROLLBACK;" >/dev/null 2>&1
q "INSERT INTO public.investor_portfolios (portfolio_code, roi_percentage, status) VALUES ('R7b', 20, NULL);" >/dev/null 2>&1
check "R7 no orphan requests" "$(q "SELECT count(*) FROM public.portfolio_rate_approvals")" "0"

# ---- Next-cycle application (approved rates wait for the cycle's Returns event) ----
payout() { q "INSERT INTO public.pending_wallet_operations (source_id, source_table, category, status, reviewed_at) VALUES ('$1', 'investor_portfolios', 'roi_payout', 'approved', now() - interval '$2')"; }
approved() { # portfolio -> one approved (scheduled) request for 20
  q "UPDATE public.investor_portfolios SET roi_percentage = 20 WHERE id = '$1'"
  qcfo "SELECT public.cfo_decide_portfolio_rate_requests(ARRAY(SELECT id FROM public.portfolio_rate_approvals WHERE portfolio_id = '$1' AND status = 'pending'), 'approve', 'ok')" >/dev/null
}
job() { qcfo "SELECT public.apply_due_portfolio_rate_changes()"; }

echo "== R8 the cycle rule"
reset
PA=$(newp due 15); PB=$(newp waits 15); PC=$(newp grace 15); PD=$(newp nopay 15); on
payout "$PA" '20 days'; approved "$PA"; q "UPDATE public.portfolio_rate_approvals SET decided_at = now() - interval '25 days' WHERE portfolio_id = '$PA'"
payout "$PB" '20 days'; approved "$PB"
payout "$PC" '3 days';  approved "$PC"
approved "$PD"
job >/dev/null
check "R8 approved before the last payout -> applied" "$(q "SELECT roi_percentage::int FROM public.investor_portfolios WHERE id='$PA'")" "20"
check "R8 approved mid-cycle (payout 20 days ago) -> waits" "$(q "SELECT roi_percentage::int FROM public.investor_portfolios WHERE id='$PB'")" "15"
check "R8 approved within 10 days after a payout -> joins this cycle" "$(q "SELECT roi_percentage::int FROM public.investor_portfolios WHERE id='$PC'")" "20"
check "R8 no payout yet -> waits for the first cycle" "$(q "SELECT roi_percentage::int FROM public.investor_portfolios WHERE id='$PD'")" "15"
payout "$PB" '0 days'; job >/dev/null
check "R8 the waiting one applies once its cycle is paid" "$(q "SELECT roi_percentage::int FROM public.investor_portfolios WHERE id='$PB'")" "20"

echo "== R9 next-cycle job meets a portfolio locked by an in-flight payout"
reset; P=$(newp R9 15); on; payout "$P" '1 day'; approved "$P"
q "BEGIN; SELECT 1 FROM public.investor_portfolios WHERE id = '$P' FOR UPDATE; SELECT pg_sleep(1.5); COMMIT;" > "$OUT/a" 2>&1 &
sleep 0.3
START=$(date +%s%N); J=$(job); END=$(date +%s%N)
check "R9 job skips the busy portfolio without waiting" "$(echo "$J" | grep -o '"skipped_locked": [0-9]')|$(( (END-START)/1000000 < 1000 ))" '"skipped_locked": 1|1'
wait
job >/dev/null
check "R9 applied on the next run" "$(q "SELECT roi_percentage::int FROM public.investor_portfolios WHERE id='$P'")/$(nerrs)" "20/0"

echo "== R10 two next-cycle jobs at once over 60 due portfolios"
reset
for i in $(seq 1 60); do newp "R10-$i" 15 >/dev/null; done; on
for P in $(q "SELECT id FROM public.investor_portfolios"); do payout "$P" '1 day'; approved "$P"; done
qcfo "BEGIN; SELECT public.apply_due_portfolio_rate_changes(); SELECT pg_sleep(0.3); COMMIT;" > "$OUT/a" 2>&1 &
qcfo "BEGIN; SELECT public.apply_due_portfolio_rate_changes(); SELECT pg_sleep(0.3); COMMIT;" > "$OUT/b" 2>&1 &
wait
check "R10 each applied exactly once" "$(q "SELECT count(*) FILTER (WHERE roi_percentage = 20) || '/' || (SELECT count(*) FROM public.portfolio_rate_approvals WHERE applied_at IS NOT NULL) || '/' || (SELECT count(*) FROM public.audit_logs WHERE action_type = 'portfolio_rate_applied_next_cycle') FROM public.investor_portfolios")/$(nerrs)" "60/60/60/0"

echo "== R11 next-cycle job racing a staff edit on the same portfolio (both orders)"
for order in edit_first job_first; do
  reset; P=$(newp R11 15); on; payout "$P" '1 day'; approved "$P"
  EDIT="BEGIN; UPDATE public.investor_portfolios SET roi_percentage = 25 WHERE id = '$P'; SELECT pg_sleep(0.6); COMMIT;"
  JOB="BEGIN; SELECT public.apply_due_portfolio_rate_changes(); SELECT pg_sleep(0.6); COMMIT;"
  if [ $order == edit_first ]; then
    qcfo "$EDIT" > "$OUT/a" 2>&1 & sleep 0.2; qcfo "$JOB" > "$OUT/b" 2>&1 & wait
    job >/dev/null   # a later run must not resurrect the superseded approval
    check "R11 $order: edit wins, approval superseded, 25 pending" "$(q "SELECT roi_percentage::int || '|' || string_agg(a.status || ':' || a.requested_rate::int, ',' ORDER BY a.requested_at) FROM public.investor_portfolios ip JOIN public.portfolio_rate_approvals a ON a.portfolio_id = ip.id WHERE ip.id='$P' GROUP BY ip.roi_percentage")/$(nerrs)" "15|superseded:20,pending:25/0"
  else
    qcfo "$JOB" > "$OUT/a" 2>&1 & sleep 0.2; qcfo "$EDIT" > "$OUT/b" 2>&1 & wait
    check "R11 $order: 20 applied, then 25 requested with 20 in force" "$(q "SELECT roi_percentage::int || '|' || string_agg(a.status || ':' || a.requested_rate::int || '@' || a.rate_in_force::int, ',' ORDER BY a.requested_at) FROM public.investor_portfolios ip JOIN public.portfolio_rate_approvals a ON a.portfolio_id = ip.id WHERE ip.id='$P' GROUP BY ip.roi_percentage")/$(nerrs)" "20|approved:20@15,pending:25@20/0"
  fi
done

# ===========================================================================
# Cut-off races (per-person rules)
# ===========================================================================
echo "== S1 two concurrent CEO first switch-ons (5 rounds) + CEO racing a database-owner UPDATE (both orders)"
for i in 1 2 3 4 5; do
  reset; seed_population
  qceo "BEGIN; SELECT public.set_partner_return_policy(true); SELECT pg_sleep(0.3); COMMIT;" > "$OUT/a" 2>&1 &
  qceo "BEGIN; SELECT public.set_partner_return_policy(true); SELECT pg_sleep(0.3); COMMIT;" > "$OUT/b" 2>&1 &
  wait
  check "S1.$i one changed, one no-op; cut-off set once; cohort = live holders exactly; one email pair; no errors" \
    "$(cat "$OUT/a" "$OUT/b" | grep -o '"changed": [a-z]*' | sort | tr '\n' ' ')|$(q "SELECT (cutoff_at IS NOT NULL)::text || '/' || ($COHORT_DIFF) || '/' || (SELECT count(*) FROM public.partner_return_cohort) || '/' || (SELECT count(*) FROM public._email_outbox) || '/' || (SELECT count(*) FROM public.audit_logs WHERE action_type = 'set_partner_return_policy') FROM public.partner_return_policy")/$(nerrs)" \
    '"changed": false "changed": true |true/0/33/2/1/0'
done
for order in ceo_first owner_first; do
  reset; seed_population
  CEOQ="BEGIN; SELECT public.set_partner_return_policy(true); SELECT pg_sleep(0.3); COMMIT;"
  OWNQ="BEGIN; UPDATE public.partner_return_policy SET enabled = true; SELECT pg_sleep(0.3); COMMIT;"
  if [ $order == ceo_first ]; then qceo "$CEOQ" > "$OUT/a" 2>&1 & sleep 0.1; q "$OWNQ" > "$OUT/b" 2>&1 & wait
  else q "$OWNQ" > "$OUT/a" 2>&1 & sleep 0.1; qceo "$CEOQ" > "$OUT/b" 2>&1 & wait; fi
  check "S1 $order: cut-off set once, cohort exact, no errors" "$(q "SELECT enabled::text || '/' || (cutoff_at IS NOT NULL)::text || '/' || ($COHORT_DIFF) || '/' || (SELECT count(*) FROM public.partner_return_cohort) FROM public.partner_return_policy")/$(nerrs)" "true/true/0/33/0"
done

echo "== S2 CEO switch-on racing 4 sessions inserting portfolios for a mix of people (3 rounds)"
mkfile_s2() { # session -> 80 single-row autocommit inserts, null rate
  local s=$1; for i in $(seq 1 80); do
    case $((i % 4)) in 0) p="e20_$((i % 5 + 1))";; 1) p="e14_$((i % 5 + 1))";; 2) p="emp_$((i % 5 + 1))";; 3) p="fs${s}_$((i % 15 + 1))";; esac
    echo "SELECT public.r_new('$p') IS NULL; SELECT pg_sleep(0.004);"
  done > "$OUT/s2_$s.sql"; }
for round in 1 2 3; do
  reset; seed_population
  for s in 1 2 3 4; do mkfile_s2 $s; done
  T0=$(q "SELECT clock_timestamp()")
  for s in 1 2 3 4; do qf "$OUT/s2_$s.sql" > "$OUT/s2_$s.log" 2>&1 & done
  sleep 0.35
  qceo "SELECT public.set_partner_return_policy(true)" > "$OUT/ceo.log" 2>&1
  wait
  SPLIT=$(q "SELECT count(*) FILTER (WHERE ip.rate_decided_at > '$T0'::timestamptz AND ip.rate_decided_at < p.cutoff_at) || ' before / ' || count(*) FILTER (WHERE ip.rate_decided_at >= p.cutoff_at) || ' after the cut-off' FROM public.investor_portfolios ip, public.partner_return_policy p")
  check "S2.$round basis switch_off <=> decided before the cut-off (and 15)" "$(q "SELECT count(*) FROM public.investor_portfolios ip, public.partner_return_policy p WHERE (ip.rate_basis IN ('switch_off','typed_switch_off')) <> (ip.rate_decided_at < p.cutoff_at) OR (ip.rate_basis = 'switch_off' AND ip.roi_percentage <> 15)")" "0"
  check "S2.$round every switch-off-decided investor is in the cohort" "$(q "SELECT count(*) FROM public.investor_portfolios ip WHERE ip.rate_basis IN ('switch_off','typed_switch_off') AND ip.status IN ('active','locked') AND NOT EXISTS (SELECT 1 FROM public.partner_return_cohort c WHERE c.partner_id = ip.investor_id)")" "0"
  check "S2.$round cohort = live holders decided before the cut-off (exact counts/rates)" "$(q "$COHORT_DIFF")" "0"
  check "S2.$round nobody whose first live portfolio came after the cut-off is in the cohort" "$(q "SELECT count(*) FROM public.partner_return_cohort c, public.partner_return_policy p WHERE c.basis = 'live_portfolio' AND NOT EXISTS (SELECT 1 FROM public.investor_portfolios ip WHERE ip.investor_id = c.partner_id AND ip.rate_decided_at < p.cutoff_at)")" "0"
  check "S2.$round every post-cut-off row has that person's rate and basis" "$(q "SELECT count(*) FROM public.investor_portfolios ip
         CROSS JOIN public.partner_return_policy p
         LEFT JOIN public.partner_return_cohort c ON c.partner_id = ip.investor_id
         LEFT JOIN public.hr_staff st ON st.user_id = ip.investor_id AND st.active
        WHERE ip.rate_decided_at >= p.cutoff_at
          AND (ip.roi_percentage IS DISTINCT FROM CASE WHEN st.user_id IS NOT NULL THEN 20 WHEN c.partner_id IS NOT NULL THEN GREATEST(10, c.max_rate) ELSE 10 END
               OR ip.rate_basis IS DISTINCT FROM CASE WHEN st.user_id IS NOT NULL THEN 'employee' WHEN c.partner_id IS NOT NULL THEN 'existing_partner' ELSE 'new' END)")" "0"
  check "S2.$round no errors (no lock timeouts, no deadlocks)" "$(nerrs)" "0"
  echo "      rows decided: $SPLIT; fresh people in cohort: $(q "SELECT count(*) FROM public.partner_return_cohort WHERE partner_id IN (SELECT public.pid('fs' || s || '_' || i) FROM generate_series(1,4) s, generate_series(1,15) i)")"
done

echo "== S3 CEO switch-on racing a redemption of someone's only live portfolio (8 rounds, both orders)"
for round in 1 2 3 4 5 6 7 8; do
  reset; seed_population; q "SELECT public.r_new('rr', 20)" >/dev/null
  RED="BEGIN; UPDATE public.investor_portfolios SET status = 'redeemed' WHERE investor_id = public.pid('rr'); INSERT INTO public._race_marks (k) VALUES ('redeemed'); SELECT pg_sleep(0.3); COMMIT;"
  SW="BEGIN; SELECT public.set_partner_return_policy(true); SELECT pg_sleep(0.3); COMMIT;"
  if [ $((round % 2)) = 1 ]; then q "$RED" > "$OUT/a" 2>&1 & sleep 0.1; qceo "$SW" > "$OUT/b" 2>&1 & wait
  else qceo "$SW" > "$OUT/a" 2>&1 & sleep 0.1; q "$RED" > "$OUT/b" 2>&1 & wait; fi
  check "S3.$round in cohort <=> redemption landed after the cut-off; afterwards 10 new; cohort exact; no errors" \
    "$(q "SELECT (EXISTS (SELECT 1 FROM public.partner_return_cohort WHERE partner_id = public.pid('rr')) = ((SELECT at FROM public._race_marks) > p.cutoff_at))::text
            || '/' || (SELECT trim_scale(rate) || ' ' || basis FROM public.partner_rates_for(ARRAY[public.pid('rr')]))
            || '/' || ((SELECT count(*) FROM public.partner_return_cohort) - (EXISTS (SELECT 1 FROM public.partner_return_cohort WHERE partner_id = public.pid('rr')))::int)
            FROM public.partner_return_policy p")/$(nerrs)" "true/10 new/33/0"
  echo "      order $([ $((round % 2)) = 1 ] && echo redemption-first || echo switch-first): rr in cohort = $(q "SELECT EXISTS (SELECT 1 FROM public.partner_return_cohort WHERE partner_id = public.pid('rr'))")"
done

echo "== S4 4 x 150 mixed concurrent inserts with the switch on -> exact counts per persona"
reset; seed_population; qceo "SELECT public.set_partner_return_policy(true)" >/dev/null
for s in 1 2 3 4; do
  for i in $(seq 1 150); do
    case $((i % 5)) in
      0) echo "SELECT public.r_new('f4_${s}_$i') IS NULL;";;
      1) echo "SELECT public.r_new('e20_$((i % 5 + 1))') IS NULL;";;
      2) echo "SELECT public.r_new('e14_$((i % 5 + 1))') IS NULL;";;
      3) echo "SELECT public.r_new('emp_$((i % 5 + 1))') IS NULL;";;
      4) echo "SELECT public.r_new('g4_${s}_$i', 20) IS NULL;";;
    esac
  done > "$OUT/s4_$s.sql"
done
for s in 1 2 3 4; do qf "$OUT/s4_$s.sql" > "$OUT/s4_$s.log" 2>&1 & done
wait
check "S4 counts per persona after the cut-off (rate|basis x n), pending requests, errors" \
  "$(q "SELECT string_agg(k || 'x' || n, ' ' ORDER BY k) FROM (SELECT trim_scale(roi_percentage) || '|' || rate_basis AS k, count(*) n FROM public.investor_portfolios ip, public.partner_return_policy p WHERE ip.rate_decided_at >= p.cutoff_at GROUP BY 1) s")/$(q "SELECT count(*) || ':' || string_agg(DISTINCT trim_scale(requested_rate)::text, ',') FROM public.portfolio_rate_approvals WHERE status = 'pending'")/$(nerrs)" \
  "10|newx240 14|existing_partnerx120 20|employeex120 20|existing_partnerx120/120:20/0"

echo "== S5 first switch-on while a long transaction holds a portfolio write (the guard waits at most 0.5 s; Phase 6 F5)"
reset; seed_population
q "BEGIN; SELECT public.r_new('slowpoke', 15); SELECT pg_sleep(5); COMMIT;" > "$OUT/a" 2>&1 &
sleep 0.3
q "SELECT pg_sleep(0.5); INSERT INTO public._race_marks (k) VALUES ('c_start'); SELECT public.r_new('bystander', 15); INSERT INTO public._race_marks (k) VALUES ('c_end');" > "$OUT/c.log" 2>&1 &
START=$(date +%s%N); PGOPTIONS="-c request.jwt.claim.sub=$CEO" "$PSQL" -h localhost -p "$PORT" -U postgres -d postgres -X -q -At -v VERBOSITY=verbose -c "SELECT public.set_partner_return_policy(true)" > "$OUT/sw.log" 2>&1; END=$(date +%s%N)
SWMS=$(( (END-START)/1000000 ))
wait
# Phase 6 F5: the guard waits at most 0.5 s for its SHARE lock, then refuses with SQLSTATE 55P03 and a retry message
# (HINT: the payout windows). VERBOSITY=verbose prints the SQLSTATE.
check "S5 switch-on refused after ~0.5 s (55P03 'Partner Returns was not switched on ... try again in a minute', payout-window hint); switch still off, no cut-off, no cohort, no email" \
  "$(grep -c 'ERROR:  55P03: Partner Returns was not switched on: portfolios are being updated right now' "$OUT/sw.log")$(grep -c 'HINT:  Switch on outside the payout runs' "$OUT/sw.log")|$(( SWMS >= 400 && SWMS < 1500 ))|$(q "SELECT enabled::text || '/' || (cutoff_at IS NULL)::text || '/' || (SELECT count(*) FROM public.partner_return_cohort) || '/' || (SELECT count(*) FROM public._email_outbox) FROM public.partner_return_policy")" \
  "11|1|false/true/0/0"
echo "      switch-on waited ${SWMS} ms; a bystander insert queued behind it waited $(q "SELECT round(extract(epoch FROM max(at) FILTER (WHERE k='c_end') - max(at) FILTER (WHERE k='c_start')) * 1000) FROM public._race_marks") ms"
rm -f "$OUT"/sw.log "$OUT"/a "$OUT"/c.log
# The retry runs in a session whose lock_timeout is 7s: the guard sets 500ms only for the SHARE lock and puts the
# caller's value back (SHOW in the same transaction).
qceo "SET lock_timeout = '7s'; SELECT (public.set_partner_return_policy(true) ->> 'enabled'); SHOW lock_timeout" > "$OUT/sw2.log" 2>&1
check "S5 retry after the long transaction commits succeeds and includes its portfolio; the caller's lock_timeout (7s) is restored after the guard" \
  "$(q "SELECT enabled::text || '/' || EXISTS (SELECT 1 FROM public.partner_return_cohort WHERE partner_id = public.pid('slowpoke')) || '/' || ($COHORT_DIFF) FROM public.partner_return_policy")/$(nerrs)/$(tr -d '\r' < "$OUT/sw2.log" | paste -sd, -)" "true/true/0/0/true,7s"

echo
echo "RESULT: $pass passed, $fail failed"
