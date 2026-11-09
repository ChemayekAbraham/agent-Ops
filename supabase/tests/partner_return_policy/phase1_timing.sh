#!/usr/bin/env bash
# Gate overhead on a THROWAWAY local Postgres (port 55432): 600 single-row portfolio inserts through
# the Partner Returns gate (switch ON, null rate -> decider) vs the same inserts with the gate trigger
# disabled (typed rate, since roi_percentage has no default). Prerequisite: stub + Phase 1 loaded.
PSQL="${PSQL:-C:/Program Files/PostgreSQL/18/bin/psql.exe}"
PORT="${PORT:-55432}"
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/out_timing"; rm -rf "$OUT"; mkdir -p "$OUT"
q()  { "$PSQL" -h localhost -p "$PORT" -U postgres -d postgres -X -q -At -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
qf() { "$PSQL" -h localhost -p "$PORT" -U postgres -d postgres -X -q -At -v ON_ERROR_STOP=1 -f "$1" >/dev/null; }
CEO=$(q "SELECT public.pid('ceo')")

echo "-- population: 20,000 portfolios over 8,000 investors, 2,000 notes, 300 staff, 200 signed agreements"
q "INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, status, roi_percentage)
   SELECT public.pid('bg_' || (i % 8000)), public.pid('agent1'), 'BG-' || i, 100000,
          CASE WHEN i % 10 = 0 THEN 'redeemed' WHEN i % 13 = 0 THEN 'locked' ELSE 'active' END, (ARRAY[10,14,15,20])[1 + i % 4]
     FROM generate_series(1, 20000) i;
   INSERT INTO public.promissory_notes (agent_id, partner_user_id, amount, status, fulfilment_due_on, recorded_on)
   SELECT public.pid('agent1'), public.pid('bg_' || (i * 3 % 8000)), 1000, 'activated', current_date - 10, current_date - 40 FROM generate_series(1, 2000) i;
   INSERT INTO public.hr_staff (user_id, active) SELECT public.pid('st_' || i), i % 7 <> 0 FROM generate_series(1, 300) i;
   INSERT INTO public.partner_agreements (partner_id, partner_signature_data_url) SELECT public.pid('sg_' || i), 'data:x' FROM generate_series(1, 200) i;" >/dev/null
PGOPTIONS="-c request.jwt.claim.sub=$CEO" "$PSQL" -h localhost -p "$PORT" -U postgres -d postgres -X -q -At -c "SELECT public.set_partner_return_policy(true)" >/dev/null
q "ANALYZE" >/dev/null
echo "   switch on; existing partners frozen: $(q "SELECT count(*) FROM public.partner_return_cohort")"

# The 600 people: existing partners, fresh people, staff, note holders, in rotation.
PERSON="CASE i % 4 WHEN 0 THEN 'bg_' || (i * 7 % 8000) WHEN 1 THEN 'tm_new_' || i WHEN 2 THEN 'st_' || (i % 300 + 1) ELSE 'bg_' || (i * 3 % 8000) END"

server_loop() { # $1 = rate expression ('NULL' or '15'); prints ms for 600 inserts (one transaction, rolled back)
  q "BEGIN; $2
     DO \$\$ DECLARE t0 timestamptz := clock_timestamp(); BEGIN
       FOR i IN 1..600 LOOP
         INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, roi_percentage)
         VALUES (public.pid($PERSON), public.pid('agent1'), 'TM-' || i, 100000, $1);
       END LOOP;
       PERFORM set_config('t.ms', (extract(epoch FROM clock_timestamp() - t0) * 1000)::numeric(10,1)::text, true);
     END \$\$;
     SELECT current_setting('t.ms'); ROLLBACK;" | tail -1
}
client_file() { # $1 = rate; 600 autocommit statements
  for i in $(seq 1 600); do
    case $((i % 4)) in 0) p="bg_$((i * 7 % 8000))";; 1) p="tm_new_$i";; 2) p="st_$((i % 300 + 1))";; 3) p="bg_$((i * 3 % 8000))";; esac
    echo "INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, roi_percentage) VALUES (public.pid('$p'), public.pid('agent1'), 'TC-$i', 100000, $1);"
  done > "$OUT/c_$2.sql"
}
client_run() { # file -> ms
  local s e; s=$(date +%s%N); qf "$1"; e=$(date +%s%N); echo $(( (e - s) / 1000000 ))
  q "DELETE FROM public.portfolio_rate_approvals WHERE portfolio_id IN (SELECT id FROM public.investor_portfolios WHERE portfolio_code LIKE 'TC-%');
     DELETE FROM public.investor_portfolios WHERE portfolio_code LIKE 'TC-%';" >/dev/null
}
median() { printf '%s\n' "$@" | sort -n | sed -n "$(( ($# + 1) / 2 ))p"; }

client_file NULL gate; client_file 15 nogate
GS=(); NS=(); OS=(); GC=(); NC=()
for r in 1 2 3 4 5; do
  GS+=("$(server_loop NULL '')")
  NS+=("$(server_loop 15 'ALTER TABLE public.investor_portfolios DISABLE TRIGGER trg_partner_return_rate_policy;')")
  OS+=("$(server_loop NULL 'UPDATE public.partner_return_policy SET enabled = false;')")
done
for r in 1 2 3; do
  GC+=("$(client_run "$OUT/c_gate.sql")")
  q "ALTER TABLE public.investor_portfolios DISABLE TRIGGER trg_partner_return_rate_policy" >/dev/null
  NC+=("$(client_run "$OUT/c_nogate.sql")")
  q "ALTER TABLE public.investor_portfolios ENABLE TRIGGER trg_partner_return_rate_policy" >/dev/null
done
gs=$(median "${GS[@]}"); ns=$(median "${NS[@]}"); os=$(median "${OS[@]}"); gc=$(median "${GC[@]}"); nc=$(median "${NC[@]}")
echo "TIMING server-side, 600 inserts in one transaction (5 runs each, median):"
echo "TIMING   gate ON  (decider): ${gs} ms  [${GS[*]}]"
echo "TIMING   switch OFF (gate fast path): ${os} ms  [${OS[*]}]"
echo "TIMING   gate trigger disabled: ${ns} ms  [${NS[*]}]"
awk -v g="$gs" -v n="$ns" -v o="$os" 'BEGIN { printf "TIMING   overhead per insert: switch ON %.3f ms, switch OFF %.3f ms\n", (g-n)/600, (o-n)/600 }'
echo "TIMING client-side, 600 autocommit statements via psql -f (3 runs each, median):"
echo "TIMING   gate ON: ${gc} ms  [${GC[*]}]   gate disabled: ${nc} ms  [${NC[*]}]"
awk -v g="$gc" -v n="$nc" 'BEGIN { printf "TIMING   overhead per insert: %.3f ms (%.3f vs %.3f ms per insert)\n", (g-n)/600, g/600, n/600 }'
q "BEGIN;
   INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, roi_percentage)
   SELECT public.pid($PERSON), public.pid('agent1'), 'TM-' || i, 100000, NULL FROM generate_series(1, 600) i;
   SELECT 'TIMING   what the 600 gated inserts got: ' || string_agg(k, ' ' ORDER BY k) FROM (SELECT trim_scale(roi_percentage) || '|' || rate_basis || 'x' || count(*) k FROM public.investor_portfolios WHERE portfolio_code LIKE 'TM-%' GROUP BY roi_percentage, rate_basis) s;
   ROLLBACK;" | grep TIMING
