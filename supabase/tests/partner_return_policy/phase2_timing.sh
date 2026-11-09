#!/usr/bin/env bash
# Phase 2 cost on a THROWAWAY local Postgres (port 55432). Prerequisite: stub + stub2 + both
# migrations loaded, switch never turned on (run_phase2_tests.sh does this).
#  1. Reworked creation paths vs. a copy of the same function with the old literal 15 (typed into
#     the portfolio, no partner_rate_now call): 200 calls per run in one transaction (rolled back),
#     5 runs each, median. People are existing 15% partners, so both versions store the same rate.
#  2. The late-link trigger, enabled vs disabled, before and after the cut-off: a plain UPDATE of 1,000
#     notes that links nobody, and an UPDATE that links 1,000 pre-cut-off notes to 1,000 people.
#  3. One registration linking a note; one statement linking 5,000 and 20,000 people (round 3: the rate lock
#     is bucketed, at most 256 advisory locks per transaction; round 2 failed at 20,000 with 53200).
#  4. (round 5) The Phase 1 gate's UPDATE path with the switch on (every rate change queues a CFO request): the round-5 body
#     (shipped: open requests locked in id order, INSERT ... ON CONFLICT DO NOTHING, one retry, no sub-transaction) vs the
#     round-4 body (the same statements inside BEGIN ... EXCEPTION, one sub-transaction per change) vs the round-3 body (no
#     lock, no retry); t_gate_body() rebuilds the older two from the shipped text.
#     a. one UPDATE changing the rate of 1,000 live portfolios, 7 runs per body (each rolled back, the older bodies put back
#        inside the same transaction), and the sub-transaction cache it leaves (pg_stat_get_backend_subxact);
#     b. single-row rate changes, each committed on its own as staff edits arrive (a server-side loop of 1,500 over 2,000
#        portfolios), 3 runs per body, interleaved; the older bodies are installed for the run and the shipped text is put
#        back and md5-checked afterwards.
# The switch-on needs release_ready (set by the release migration, Phase 7): set here as a stand-in.
PSQL="${PSQL:-C:/Program Files/PostgreSQL/18/bin/psql.exe}"
PORT="${PORT:-55432}"
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/out_timing_phase2"; rm -rf "$OUT"; mkdir -p "$OUT"
q()  { "$PSQL" -h localhost -p "$PORT" -U postgres -d postgres -X -q -At -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
median() { printf '%s\n' "$@" | sort -n | sed -n "$(( ($# + 1) / 2 ))p"; }
N=200

( cd "$DIR" && "$PSQL" -h localhost -p "$PORT" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f phase2_helpers.sql ) >/dev/null 2>&1 \
  || { echo "FAIL  helpers did not load"; exit 1; }

echo "-- population: 20,000 portfolios over 8,000 investors, 2,000 linked notes + 1,000 unlinked, 300 staff, 200 signed agreements,"
echo "   600 existing 15% partners with agreements for the creation paths"
q "INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, duration_months, portfolio_pin, status, roi_percentage)
   SELECT public.pid('bg_' || (i % 8000)), public.pid('agent1'), 'BG-' || i, 100000, 12, '1111',
          CASE WHEN i % 10 = 0 THEN 'redeemed' WHEN i % 13 = 0 THEN 'locked' ELSE 'active' END, (ARRAY[10,14,15,20])[1 + i % 4]
     FROM generate_series(1, 20000) i;
   INSERT INTO public.promissory_notes (agent_id, partner_user_id, partner_name, whatsapp_number, amount, status, fulfilment_due_on, recorded_on)
   SELECT public.pid('agent1'), public.pid('bg_' || (i * 3 % 8000)), 'BG note ' || i, '0790' || lpad(i::text, 6, '0'), 1000, 'activated', current_date - 10, current_date - 40
     FROM generate_series(1, 2000) i;
   INSERT INTO public.promissory_notes (agent_id, partner_user_id, partner_name, whatsapp_number, amount, status, fulfilment_due_on, recorded_on)
   SELECT public.pid('agent1'), NULL, 'Unlinked ' || i, '0791' || lpad(i::text, 6, '0'), 1000, 'pending', current_date + 5, current_date - 3
     FROM generate_series(1, 1000) i;
   INSERT INTO public.hr_staff (user_id, active) SELECT public.pid('st_' || i), i % 7 <> 0 FROM generate_series(1, 300) i;
   INSERT INTO public.partner_agreements (partner_id, partner_signature_data_url, status) SELECT public.pid('sg_' || i), 'data:x', 'signed' FROM generate_series(1, 200) i;
   SELECT public.t2_person('tm_' || i) FROM generate_series(1, 600) i;
   INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, duration_months, portfolio_pin, status, roi_percentage)
   SELECT public.pid('tm_' || i), public.pid('agent1'), 'TMX-' || i, 100000, 12, '1111', 'active', 15 FROM generate_series(1, 600) i;" >/dev/null
q "ANALYZE" >/dev/null

# Old-literal copies of the three reworked creation paths (same text, rate 15 typed, no rule call).
q "DO \$\$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('public.funder_create_pending_portfolio(numeric,uuid,integer)'::regprocedure);
  n := replace(replace(replace(d, 'FUNCTION public.funder_create_pending_portfolio(', 'FUNCTION public.t_old_fcpp('),
         'roi_mode, status, portfolio_pin', 'roi_percentage, roi_mode, status, portfolio_pin'),
         \$a\$'monthly_payout', 'pending_ops_approval',\$a\$, \$b\$15, 'monthly_payout', 'pending_ops_approval',\$b\$);
  IF n = d OR position('roi_percentage, roi_mode' in n) = 0 THEN RAISE EXCEPTION 'fcpp copy failed'; END IF;
  EXECUTE n;
  d := pg_get_functiondef('public.psm_confirm_commitment_for(uuid,uuid[],integer,text,uuid,uuid,text)'::regprocedure);
  n := replace(replace(replace(replace(d, 'FUNCTION public.psm_confirm_commitment_for(', 'FUNCTION public.t_old_psm('),
         'v_rate := public.partner_rate_now(p_partner);', 'v_rate := 15;'),
         'roi_mode, status, portfolio_pin', 'roi_percentage, roi_mode, status, portfolio_pin'),
         \$a\$'monthly_payout', 'pending_ops_approval',\$a\$, \$b\$v_rate, 'monthly_payout', 'pending_ops_approval',\$b\$);
  IF position('partner_rate_now' in n) > 0 OR position('roi_percentage, roi_mode' in n) = 0 THEN RAISE EXCEPTION 'psm copy failed'; END IF;
  EXECUTE n;
  d := pg_get_functiondef('public.partner_support_houses(uuid[],integer,text,uuid)'::regprocedure);
  n := replace(replace(replace(replace(d, 'FUNCTION public.partner_support_houses(', 'FUNCTION public.t_old_psh4('),
         'v_rate := public.partner_rate_now(v_partner);', 'v_rate := 15;'),
         'roi_mode, status, portfolio_pin', 'roi_percentage, roi_mode, status, portfolio_pin'),
         \$a\$'monthly_payout', 'pending_ops_approval',\$a\$, \$b\$v_rate, 'monthly_payout', 'pending_ops_approval',\$b\$);
  IF position('partner_rate_now' in n) > 0 OR position('roi_percentage, roi_mode' in n) = 0 THEN RAISE EXCEPTION 'psh4 copy failed'; END IF;
  EXECUTE n;
END \$\$;" || { echo "FAIL  old-literal copies"; exit 1; }

# One run: $1 = path (fcpp|psm|psh4), $2 = new|old. Prints ms for N calls (fixtures made before the clock starts).
run() {
  local call
  case "$1/$2" in
    fcpp/new) call="PERFORM public.funder_create_pending_portfolio(100000);" ;;
    fcpp/old) call="PERFORM public.t_old_fcpp(100000);" ;;
    psm/new)  call="PERFORM public.psm_confirm_commitment_for(public.pid('tm_' || i), ARRAY[v_plans[2*i-1], v_plans[2*i]], 1, NULL, NULL, NULL, 'float');" ;;
    psm/old)  call="PERFORM public.t_old_psm(public.pid('tm_' || i), ARRAY[v_plans[2*i-1], v_plans[2*i]], 1, NULL, NULL, NULL, 'float');" ;;
    psh4/new) call="PERFORM public.partner_support_houses(ARRAY[v_houses[i]], 1, NULL::text, NULL::uuid); DROP TABLE _psh_pick;" ;;
    psh4/old) call="PERFORM public.t_old_psh4(ARRAY[v_houses[i]], 1, NULL::text, NULL::uuid); DROP TABLE _psh_pick;" ;;
  esac
  q "BEGIN;
     DO \$\$ DECLARE t0 timestamptz; v_plans uuid[]; v_houses uuid[]; BEGIN
       SELECT array_agg(public.t2_plan(150000)) INTO v_plans FROM generate_series(1, 2 * $N);
       SELECT array_agg(public.t2_house(200000)) INTO v_houses FROM generate_series(1, $N);
       t0 := clock_timestamp();
       FOR i IN 1..$N LOOP
         PERFORM set_config('request.jwt.claim.sub', public.pid('tm_' || i)::text, true);
         $call
       END LOOP;
       PERFORM set_config('t.ms', (extract(epoch FROM clock_timestamp() - t0) * 1000)::numeric(10,1)::text, true);
       PERFORM set_config('t.check', (SELECT string_agg(DISTINCT trim_scale(roi_percentage) || '|' || rate_basis, ',')
                                        FROM public.investor_portfolios WHERE rate_decided_at >= t0), true);
     END \$\$;
     SELECT current_setting('t.ms') || ' ' || current_setting('t.check'); ROLLBACK;" | tail -1
}
bench() { # $1 = label; runs every path new/old 5 times
  for path in fcpp psm psh4; do
    local NEW=() OLD=() chk_new chk_old r
    for k in 1 2 3 4 5; do
      r=$(run $path new); NEW+=("${r%% *}"); chk_new="${r#* }"
      r=$(run $path old); OLD+=("${r%% *}"); chk_old="${r#* }"
    done
    local mn mo; mn=$(median "${NEW[@]}"); mo=$(median "${OLD[@]}")
    echo "TIMING $1 $path: reworked ${mn} ms vs old-literal ${mo} ms for $N calls -> +$(awk -v a="$mn" -v b="$mo" 'BEGIN { printf "%.3f", (a-b)/'$N' }') ms per call  [new ${NEW[*]}] [old ${OLD[*]}]  stored: new=$chk_new old=$chk_old"
  done
}

LATE() { # $1 = label, $2 = plain | link; trigger on vs off, 7 runs each, every run rolled back
  #   plain: UPDATE of 1,000 already-linked notes that links nobody (the trigger's EXCEPT finds nothing)
  #   link:  UPDATE that links the 1,000 pre-cut-off unlinked notes to 1,000 different people (1,000 person locks)
  local ON=() OFF=() k stmt
  if [ "$2" = plain ]; then
    stmt="UPDATE public.promissory_notes SET updated_at = now() WHERE id IN (SELECT id FROM public.promissory_notes WHERE partner_user_id IS NOT NULL ORDER BY id LIMIT 1000);"
  else
    stmt="UPDATE public.promissory_notes n SET partner_user_id = public.pid('lk_' || substr(n.whatsapp_number, 5)) WHERE n.partner_user_id IS NULL AND n.whatsapp_number LIKE '0791%';"
  fi
  for k in 1 2 3 4 5 6 7; do
    ON+=("$(q "BEGIN; DO \$\$ DECLARE t0 timestamptz := clock_timestamp(); n int; BEGIN
          $stmt
          GET DIAGNOSTICS n = ROW_COUNT;
          PERFORM set_config('t.ms', (extract(epoch FROM clock_timestamp() - t0) * 1000)::numeric(10,2)::text, true);
          PERFORM set_config('t.n', n::text, true); END \$\$;
          SELECT current_setting('t.ms') || ' ' || current_setting('t.n'); ROLLBACK;" | tail -1)")
    OFF+=("$(q "BEGIN; ALTER TABLE public.promissory_notes DISABLE TRIGGER trg_zz_partner_note_linked_late;
          DO \$\$ DECLARE t0 timestamptz := clock_timestamp(); BEGIN
          $stmt
          PERFORM set_config('t.ms', (extract(epoch FROM clock_timestamp() - t0) * 1000)::numeric(10,2)::text, true); END \$\$;
          SELECT current_setting('t.ms'); ROLLBACK;" | tail -1)")
  done
  local rows="${ON[0]#* }" i; for i in "${!ON[@]}"; do ON[$i]="${ON[$i]%% *}"; done
  local mon moff; mon=$(median "${ON[@]}"); moff=$(median "${OFF[@]}")
  echo "TIMING $1 $([ "$2" = plain ] && echo "plain UPDATE of 1,000 notes (links nobody)" || echo "UPDATE linking 1,000 pre-cut-off notes to 1,000 people")  [$rows rows]: trigger on ${mon} ms vs off ${moff} ms -> +$(awk -v a="$mon" -v b="$moff" 'BEGIN { printf "%.2f", a-b }') ms per statement  [on ${ON[*]}] [off ${OFF[*]}]"
}

LATE "before the cut-off (switch never on, trigger returns at once):" plain
LATE "before the cut-off (switch never on, trigger returns at once):" link
bench "switch OFF"
q "UPDATE public.partner_return_policy SET release_ready = true" >/dev/null   # stand-in for the release migration (Phase 7)
q "SELECT public.set_partner_return_policy(true)" >/dev/null
q "ANALYZE" >/dev/null
echo "   switch on; existing partners frozen: $(q "SELECT count(*) FROM public.partner_return_cohort"); note windows: $(q "SELECT count(*) FROM public.partner_return_note_windows")"
LATE "after the cut-off (switch on):" plain
LATE "after the cut-off (switch on):" link
bench "switch ON"
# 4. Gate UPDATE path (round 5 vs round 4 vs round 3).
qf() { "$PSQL" -h localhost -p "$PORT" -U postgres -d postgres -X -q -At -v ON_ERROR_STOP=1 2>&1 | tr -d '\r'; }
gate_run() { # $1 = r5 | r4 | r3 -> 'ms rows requests subxact'
  qf <<SQL | tail -1
BEGIN;
$([ "$1" != r5 ] && echo "DO \$g\$ BEGIN EXECUTE public.t_gate_body('$1'); END \$g\$;")
DO \$\$ DECLARE t0 timestamptz := clock_timestamp(); n int; ms numeric; BEGIN
  UPDATE public.investor_portfolios SET roi_percentage = 12.5
   WHERE id IN (SELECT id FROM public.investor_portfolios WHERE portfolio_code LIKE 'BG-%' AND status = 'active' ORDER BY id LIMIT 1000);
  GET DIAGNOSTICS n = ROW_COUNT;
  ms := (extract(epoch FROM clock_timestamp() - t0) * 1000)::numeric(10,1);
  PERFORM set_config('t.r', ms || ' ' || n || ' '
    || (SELECT count(*) FROM public.portfolio_rate_approvals WHERE source = 'rate_change' AND status = 'pending' AND requested_rate = 12.5)
    || ' ' || public.t_my_subxact(), true);
END \$\$;
SELECT current_setting('t.r');
ROLLBACK;
SQL
}
G5=(); G4=(); G3=(); GR5=""; GR4=""; GR3=""
for k in 1 2 3 4 5 6 7; do
  r=$(gate_run r5); G5+=("${r%% *}"); GR5="${r#* }"
  r=$(gate_run r4); G4+=("${r%% *}"); GR4="${r#* }"
  r=$(gate_run r3); G3+=("${r%% *}"); GR3="${r#* }"
done
m5=$(median "${G5[@]}"); m4=$(median "${G4[@]}"); m3=$(median "${G3[@]}")
echo "TIMING switch ON gate rate-change UPDATE of 1,000 portfolios (each queues a CFO request): round-5 body ${m5} ms, round-4 body ${m4} ms, round-3 body ${m3} ms -> round 5 vs round 4 $(awk -v a="$m5" -v b="$m4" 'BEGIN { printf "%+.3f", (a-b)/1000 }') ms per row, vs round 3 $(awk -v a="$m5" -v b="$m3" 'BEGIN { printf "%+.3f", (a-b)/1000 }') ms per row  [r5 ${G5[*]}] [r4 ${G4[*]}] [r3 ${G3[*]}]"
echo "INFO  rows / requests / sub-transactions left (count/overflowed) by that one UPDATE: r5=$GR5  r4=$GR4  r3=$GR3"
# 4b. Single-row committed changes (as staff edits arrive): 1,500 per run over 2,000 live portfolios, 3 runs per body.
q "CREATE TABLE IF NOT EXISTS public._t_bench (n int PRIMARY KEY, id uuid NOT NULL);
   INSERT INTO public._t_bench SELECT row_number() OVER (ORDER BY id), id FROM (SELECT id FROM public.investor_portfolios
     WHERE portfolio_code LIKE 'BG-%' AND status = 'active' ORDER BY id DESC LIMIT 2000) x ON CONFLICT DO NOTHING;
   CREATE TABLE IF NOT EXISTS public._t_saved_gate (def text NOT NULL, md5 text NOT NULL);
   INSERT INTO public._t_saved_gate SELECT d, md5(d) FROM pg_get_functiondef('public.enforce_partner_return_rate_policy()'::regprocedure) d
    WHERE NOT EXISTS (SELECT 1 FROM public._t_saved_gate);
   CREATE OR REPLACE PROCEDURE public.t_bench_rate_loop(p_n int, p_seed int, INOUT p_ms numeric DEFAULT NULL)
   LANGUAGE plpgsql AS \$p\$
   DECLARE t0 timestamptz := clock_timestamp(); v uuid;
   BEGIN
     FOR i IN 1..p_n LOOP
       SELECT b.id INTO v FROM public._t_bench b WHERE b.n = 1 + ((i + p_seed) * 7919) % 2000;
       UPDATE public.investor_portfolios SET roi_percentage = 11 + ((i + p_seed) % 9) WHERE id = v;
       COMMIT;
     END LOOP;
     p_ms := round(extract(epoch FROM clock_timestamp() - t0)::numeric * 1000 / p_n, 4);
   END \$p\$;
   ANALYZE public._t_bench; ANALYZE public.portfolio_rate_approvals;" >/dev/null
gate_install() { # $1 = r5 (the saved shipped text) | r4 | r3
  if [ "$1" = r5 ]; then q "DO \$g\$ BEGIN EXECUTE (SELECT def FROM public._t_saved_gate); END \$g\$;" >/dev/null
  else q "DO \$g\$ BEGIN EXECUTE (SELECT def FROM public._t_saved_gate); EXECUTE public.t_gate_body('$1'); END \$g\$;" >/dev/null; fi
}
S5=(); S4=(); S3=()
# Round 6: fresh statistics before every run. Section 4's rolled-back bulk edits can leave portfolio_rate_approvals
# analyzed with pages but no live row; on such statistics the gate's lock (... ORDER BY a.id FOR UPDATE) is planned as a
# full primary-key scan (round-5 and round-6 index sets alike), whose cost then grows with every change until autovacuum
# re-analyzes -- which measured the statistics, not the gate body (round 6 first runs: r5 0.6 / 2.4 / 4.2 ms, r3 flat).
for k in 1 2 3; do
  for b in r5 r4 r3; do
    gate_install "$b"
    q "VACUUM (ANALYZE) public.portfolio_rate_approvals" >/dev/null
    ms=$(q "CALL public.t_bench_rate_loop(1500, $((k * 100)))" | tail -1)
    case $b in r5) S5+=("$ms");; r4) S4+=("$ms");; r3) S3+=("$ms");; esac
  done
done
gate_install r5
GATE_BACK=$(q "SELECT (md5(pg_get_functiondef('public.enforce_partner_return_rate_policy()'::regprocedure)) = md5)::text FROM public._t_saved_gate")
n5=$(median "${S5[@]}"); n4=$(median "${S4[@]}"); n3=$(median "${S3[@]}")
echo "TIMING switch ON a plain rate change of one portfolio, committed on its own (1,500 per run, server-side): round-5 body ${n5} ms, round-4 body ${n4} ms, round-3 body ${n3} ms per change  [r5 ${S5[*]}] [r4 ${S4[*]}] [r3 ${S3[*]}]; shipped gate text back: $GATE_BACK"
# A real late link for scale: one registration linking 1 note of a person with 3 portfolios inside the window.
q "SELECT public.t2_person('tm_link'); SELECT public.t2_port('tm_link', NULL, 'active') FROM generate_series(1, 3)" >/dev/null
echo "TIMING one registration linking a pre-cut-off note (person with 3 lower portfolios -> 3 CFO requests + alert): $(q "BEGIN; UPDATE public.profiles SET phone = '0791000001' WHERE id = public.pid('tm_link');
  DO \$\$ DECLARE t0 timestamptz := clock_timestamp(); n int; BEGIN n := public.link_promissory_notes_for_user(public.pid('tm_link'));
  PERFORM set_config('t.ms', (extract(epoch FROM clock_timestamp() - t0) * 1000)::numeric(10,2)::text || ' ms, linked ' || n
    || ', queued ' || (SELECT count(*) FROM public.portfolio_rate_approvals WHERE source = 'note_late_link'), true); END \$\$;
  SELECT current_setting('t.ms'); ROLLBACK;" | tail -1)"
# Bulk links: the late-link trigger takes partner_rate_lock for the linked people, bucketed (hashtext(id) & 255), so one
# transaction holds at most 256 of these advisory locks whatever the number of people. The shared lock table holds about
# max_locks_per_transaction x (max_connections + max_prepared_transactions) entries (production 64 x 160 = 10,240).
LIM=$(q "SELECT current_setting('max_locks_per_transaction') || ' x (' || current_setting('max_connections') || ' + ' || current_setting('max_prepared_transactions') || ')'")
for N in 5000 20000; do
  R=$(q "BEGIN;
    INSERT INTO public.promissory_notes (agent_id, partner_user_id, partner_name, whatsapp_number, amount, status, fulfilment_due_on, recorded_on)
    SELECT public.pid('agent1'), NULL, 'Bulk ' || i, '0799' || lpad(i::text, 6, '0'), 1000, 'pending', current_date + 5, current_date
      FROM generate_series(1, $N) i;
    DO \$\$ DECLARE t0 timestamptz := clock_timestamp(); BEGIN
      UPDATE public.promissory_notes n SET partner_user_id = public.pid('bulk_' || substr(n.whatsapp_number, 5))
       WHERE n.partner_user_id IS NULL AND n.whatsapp_number LIKE '0799%';
      PERFORM set_config('t.r', 'ok in ' || (extract(epoch FROM clock_timestamp() - t0) * 1000)::numeric(10,0) || ' ms, partner-rate locks held '
        || (SELECT count(*) FROM pg_locks l WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid() AND l.objsubid = 2
               AND l.classid = hashtext('partner-rate')::oid)
        || ', advisory locks in all ' || (SELECT count(*) FROM pg_locks l WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid()), true);
    EXCEPTION WHEN others THEN PERFORM set_config('t.r', SQLSTATE || ' ' || SQLERRM, true); END \$\$;
    SELECT current_setting('t.r'); ROLLBACK;" 2>&1 | tail -1)
  echo "INFO  one UPDATE linking notes of $N different people after the cut-off (lock table ~ $LIM): $R"
done
