#!/usr/bin/env bash
# Rollback tests for the per-person Partner Returns build. THROWAWAY local Postgres (port 55432) only:
# it reloads race_stub.sql (drops and recreates the public, auth and cron schemas). Never point it at production.
#
#  A. Phase 1 rollback on a Phase-1-only database (the database it is written for once Phase 2 is rolled back):
#     one transaction (a failure at its very last statement leaves everything as it was), switches off AND clears
#     release_ready, audited once, keeps the data and the cut-off, runs twice without writing anything the second
#     time; afterwards the switch cannot go on even with release_ready set (the assert checks fail) until Phase 1 is
#     re-applied; a release_ready left set with the switch off is cleared too.
#  B. Both phases, newest first: the Phase 2 rollback refuses while the switch is on; with the switch off it runs,
#     clears release_ready and runs again cleanly; then the Phase 1 rollback.
#
# Called by run_phase2_tests.sh (bash run_phase2_tests.sh rollback). Environment: PSQL, PORT (exported by the caller).
PSQL="${PSQL:-C:/Program Files/PostgreSQL/18/bin/psql.exe}"
PORT="${PORT:-55432}"
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG1="${MIG1:-$DIR/../../migrations/20261105150000_partner_return_policy_phase1.sql}"
MIG2="${MIG2:-$DIR/../../migrations/20261105151000_partner_return_policy_phase2.sql}"
RB1="$DIR/../../rollbacks/20261105150000_partner_return_policy_phase1.rollback.sql"
RB2="$DIR/../../rollbacks/20261105151000_partner_return_policy_phase2.rollback.sql"
OUT="$DIR/out_rollback"; rm -rf "$OUT"; mkdir -p "$OUT"
P()  { "$PSQL" -h localhost -p "$PORT" -U postgres -d postgres -X -q "$@"; }
q()  { P -At -v ON_ERROR_STOP=1 -c "$1" 2>&1 | tr -d '\r'; }
pass=0; fail=0
check() { if [ "$2" == "$3" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1  got [$2] want [$3]"; fail=$((fail+1)); fi; }
note()  { echo "INFO  $*"; }
# Runs a file the way an operator would (psql -f, stop on the first error, no -1: the file has its own BEGIN/COMMIT).
# Prints the exit code; the output goes to $OUT/<name>.
runf()  { P -v ON_ERROR_STOP=1 -f "$1" > "$OUT/$2" 2>&1; echo $?; }
apply() { P -v ON_ERROR_STOP=1 -1 -f "$1" > "$OUT/apply.out" 2>&1 || { echo "FAIL  $(basename "$1") did not apply: $(grep -m1 ERROR "$OUT/apply.out")"; exit 1; }; }
stub()  { for f in "$@"; do
            P -v ON_ERROR_STOP=1 -1 -f "$DIR/$f" > "$OUT/stub.out" 2>&1 || { echo "FAIL  $f did not load"; exit 1; }
          done; }
# What the Phase 1 rollback changes, in one line.
STATE="SELECT 'default=' || COALESCE((SELECT column_default FROM information_schema.columns WHERE table_schema = 'public'
                 AND table_name = 'investor_portfolios' AND column_name = 'roi_percentage'), 'none')
  || ' gate=' || (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_partner_return_rate_policy')
  || ' notes=' || (SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_zz_stamp_note_return_rate', 'trg_zz_guard_note_return_rate'))
  || ' cron=' || (SELECT count(*) FROM cron.job WHERE jobname IN ('apply-portfolio-rate-changes-705pm', 'partner-rate-drift-check'))
  || ' on=' || p.enabled || ' ready=' || p.release_ready || ' cutoff=' || CASE WHEN p.cutoff_at IS NULL THEN 'none' ELSE 'set' END
  || ' rb_audit=' || (SELECT count(*) FROM public.audit_logs WHERE action_type = 'partner_return_policy_rollback')
  FROM public.partner_return_policy p WHERE p.id"
KEPT="SELECT (SELECT count(*) FROM public.partner_return_cohort) || '/' || (SELECT count(*) FROM public.partner_return_note_windows)
  || '/' || (SELECT count(*) FROM public.investor_portfolios) || '/' || (SELECT count(*) FROM public.portfolio_rate_approvals)
  || '/' || (SELECT cutoff_at FROM public.partner_return_policy)"

# T2 (Phase 4 round 4): an edge-function (service_role) move of portfolio $1 to person $2 inside a rolled-back
# transaction; prints ok or SQLSTATE. The stub's service_role does not bypass RLS (production's does): a policy stands in.
SRMOVE() { q "BEGIN; CREATE POLICY _t_sr_all ON public.investor_portfolios FOR ALL TO service_role USING (true) WITH CHECK (true);
  SET LOCAL ROLE service_role;
  DO \$m\$ BEGIN UPDATE public.investor_portfolios SET investor_id = public.pid('$2') WHERE portfolio_code = '$1';
    IF NOT FOUND THEN RAISE NOTICE 'T_SR none'; ELSE RAISE NOTICE 'T_SR ok'; END IF;
  EXCEPTION WHEN others THEN RAISE NOTICE 'T_SR %', SQLSTATE; END \$m\$; ROLLBACK;" | grep -o 'T_SR [a-z0-9]*' | cut -c6-; }
CARRY="SELECT (position('OLD.investor_id' in prosrc) > 0)::text || '/' || (SELECT (pg_get_triggerdef(t.oid) LIKE '%UPDATE OF locked_from_portfolio_id, investor_id, status ON%')::text
  FROM pg_trigger t WHERE t.tgname = 'trg_partner_return_carry_guard') FROM pg_proc WHERE oid = 'public.guard_partner_return_carry()'::regprocedure"
echo "== A. Phase 1 rollback (Phase-1-only database)"
stub race_stub.sql
apply "$MIG1"
check "A0 the file is one transaction: a single BEGIN first and COMMIT last" \
  "$(grep -cE '^BEGIN;' "$RB1")/$(grep -vE '^\s*(--.*)?$' "$RB1" | head -1 | tr -d '\r')/$(grep -vE '^\s*(--.*)?$' "$RB1" | tail -1 | tr -d '\r')" "1/BEGIN;/COMMIT;"
q "INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, status)
   SELECT public.pid('rbp' || i), public.pid('agent1'), 'RB-' || i, 100000, 'active' FROM generate_series(1, 5) i;
   INSERT INTO public.promissory_notes (agent_id, partner_user_id, amount, status, fulfilment_due_on)
   VALUES (public.pid('agent1'), public.pid('rbp1'), 1000, 'pending', current_date + 10);
   UPDATE public.partner_return_policy SET release_ready = true;   -- what the release migration (Phase 7) does
   SELECT public.set_partner_return_policy(true);
   INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, status, roi_percentage)
   VALUES (public.pid('rbnew'), public.pid('agent1'), 'RB-NEW', 100000, 'pending_ops_approval', 25);" >/dev/null
S0=$(q "$STATE"); K0=$(q "$KEPT")
check "A1 (T2) after the cut-off the carry guard refuses an edge-function move of a portfolio to another partner; carve-out check still there"   "$(q "$CARRY")/$(SRMOVE RB-2 rbmove)" "true/true/42501"
check "A1 before: gate, note triggers and jobs in place, switch on, release_ready set" "$S0" "default=none gate=1 notes=2 cron=2 on=true ready=true cutoff=set rb_audit=0"
note "A1 kept data before (cohort/note windows/portfolios/CFO requests/cut-off): $K0"

# A failure at the very last statement (the rollback's own audit row) must undo every earlier step.
q "CREATE FUNCTION public._t_fail_rb() RETURNS trigger LANGUAGE plpgsql AS \$\$
   BEGIN IF NEW.action_type = 'partner_return_policy_rollback' THEN RAISE EXCEPTION 'T_FAIL_AT_END'; END IF; RETURN NEW; END \$\$;
   CREATE TRIGGER _t_fail_rb BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public._t_fail_rb();" >/dev/null
rc=$(runf "$RB1" rb1_fail)
check "A2 a failure at the last statement stops the rollback (exit 3, T_FAIL_AT_END)" "$rc/$(grep -c T_FAIL_AT_END "$OUT/rb1_fail")" "3/1"
check "A2 ... and nothing it did before is kept (one transaction)" "$(q "$STATE")" "$S0"
q "DROP TRIGGER _t_fail_rb ON public.audit_logs; DROP FUNCTION public._t_fail_rb();" >/dev/null

E0=$(q "SELECT count(*) FROM public._email_outbox")
A0=$(q "SELECT count(*) FROM public.audit_logs WHERE action_type = 'partner_return_policy_settings_changed'")
rc=$(runf "$RB1" rb1_run1)
check "A3 rollback runs (exit 0, no warning about transactions)" "$rc/$(grep -ciE 'there is (already|no) transaction' "$OUT/rb1_run1")" "0/0"
check "A3 the Phase 1 rollback keeps its functions: partner_rate_lock still there, still closed to every API role, and still works" \
  "$(q "SELECT count(*) || '/' || COALESCE(max(proacl::text), 'default') FROM pg_proc WHERE oid = to_regprocedure('public.partner_rate_lock(uuid[])')")/$(q "SELECT 'ok' FROM (SELECT public.partner_rate_lock(ARRAY[gen_random_uuid(), NULL])) x")" \
  "1/{postgres=X/postgres}/ok"
check "A3 (round 6) the one-open-request index is kept with portfolio_rate_approvals (data-forward rollback keeps the table and its indexes)" \
  "$(q "SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = 'public.portfolio_rate_approvals'::regclass AND i.indisunique AND c.relname LIKE 'portfolio_rate_approvals_one_%'")" \
  "portfolio_rate_approvals_one_open,portfolio_rate_approvals_one_pending,portfolio_rate_approvals_one_scheduled"
check "A3 (round 5; round 6: 4 arguments, the 3-argument one gone) it also keeps partner_note_window_applies (still closed) and the note windows' person/agent columns, which the kept partner_rates_for still reads (through partner_note_window_open, also kept)"   "$(q "SELECT count(*) || '/' || COALESCE(max(proacl::text), 'default') || '/' || (to_regprocedure('public.partner_note_window_applies(uuid,uuid,uuid)') IS NULL) FROM pg_proc WHERE oid = to_regprocedure('public.partner_note_window_applies(uuid,uuid,uuid,uuid)')")/$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'partner_return_note_windows' AND column_name IN ('partner_user_id', 'agent_id')")/$(q "SELECT (position('partner_note_window_open(' in pg_get_functiondef('public.partner_rates_for(uuid[],boolean)'::regprocedure)) > 0 AND position('partner_note_window_applies(' in pg_get_functiondef('public.partner_note_window_open(text,date,uuid,uuid,uuid,uuid)'::regprocedure)) > 0)::text")"   "1/{postgres=X/postgres}/true/2/true"
check "A3 rate default back, gate / note triggers / jobs gone, switch off, release_ready cleared, cut-off kept, audited once" \
  "$(q "$STATE")" "default=15 gate=0 notes=0 cron=0 on=false ready=false cutoff=set rb_audit=1"
check "A3 data kept (existing-partner list, note windows, portfolios, CFO requests, cut-off unchanged)" "$(q "$KEPT")" "$K0"
check "A3 (T2, step 2b) the carry guard is back to the carve-out check only: no investor move refusal, trigger on locked_from_portfolio_id only; an edge-function move goes through again (production today)"   "$(q "$CARRY")/$(SRMOVE RB-2 rbmove)/$(q "SELECT (pg_get_triggerdef(oid) LIKE '%BEFORE INSERT OR UPDATE OF locked_from_portfolio_id ON public.investor_portfolios%')::text || '=' || tgenabled::text FROM pg_trigger WHERE tgname = 'trg_partner_return_carry_guard'")"   "false/false/ok/true=O"
check "A3 (T2, step 2b) ... the carve-out refusal itself is kept (service_role re-parent of a portfolio refused)"   "$(q "BEGIN; CREATE POLICY _t_sr_all ON public.investor_portfolios FOR ALL TO service_role USING (true) WITH CHECK (true); SET LOCAL ROLE service_role;
        DO \$m\$ BEGIN UPDATE public.investor_portfolios SET locked_from_portfolio_id = (SELECT id FROM public.investor_portfolios WHERE portfolio_code = 'RB-1') WHERE portfolio_code = 'RB-3';
          RAISE NOTICE 'T_SR ok'; EXCEPTION WHEN others THEN RAISE NOTICE 'T_SR %', SQLSTATE; END \$m\$; ROLLBACK;" | grep -o 'T_SR [a-z0-9]*' | cut -c6-)" "42501"
check "A3 the release_ready change itself was audited and e-mailed by the policy guard (1 row, 2 mails)" \
  "$(( $(q "SELECT count(*) FROM public.audit_logs WHERE action_type = 'partner_return_policy_settings_changed'") - A0 ))/$(( $(q "SELECT count(*) FROM public._email_outbox") - E0 ))" "1/2"
check "A3 the rollback's audit row records both flags" \
  "$(q "SELECT new_values::text FROM public.audit_logs WHERE action_type = 'partner_return_policy_rollback'")" '{"enabled": false, "release_ready": false}'
check "A3 a portfolio insert without a rate gets 15 again (today's behaviour)" \
  "$(q "INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, status)
        VALUES (public.pid('rbafter'), public.pid('agent1'), 'RB-AFTER', 100000, 'active') RETURNING trim_scale(roi_percentage)")" "15"
S1=$(q "$STATE"); K1=$(q "$KEPT")
E1=$(q "SELECT count(*) FROM public._email_outbox"); A1=$(q "SELECT count(*) FROM public.audit_logs")
rc=$(runf "$RB1" rb1_run2)
check "A4 second run: exit 0, nothing changed, no audit row, no e-mail (idempotent)" \
  "$rc/$(q "$STATE")/$(q "$KEPT")/$(( $(q "SELECT count(*) FROM public.audit_logs") - A1 ))/$(( $(q "SELECT count(*) FROM public._email_outbox") - E1 ))" \
  "0/$S1/$K1/0/0"
check "A4 (T2, step 2b) after the second run the carry guard is still the carve-out check only and a move still goes through"   "$(q "$CARRY")/$(SRMOVE RB-2 rbmove)" "false/false/ok"

# After the rollback the switch cannot go on, even with release_ready set again.
q "UPDATE public.partner_return_policy SET release_ready = true" >/dev/null
check "A5 after the rollback, switch-on is refused even with release_ready set, naming the checks that fail" \
  "$(q "SELECT public.set_partner_return_policy(true)" | grep -o 'these checks fail: [a-z_, ]*' | sed 's/ *$//')" \
  "these checks fail: cron_jobs_scheduled, gate_trigger_enabled, note_triggers_enabled, rate_has_no_default"
check "A5 ... and the switch stayed off" "$(q "SELECT enabled FROM public.partner_return_policy")" "f"

# Re-applying Phase 1 restores everything; the kept cut-off and list are reused.
apply "$MIG1"
check "A6 Phase 1 re-applied: switch-on allowed again (release_ready still set), same cut-off and list" \
  "$(q "SELECT (public.set_partner_return_policy(true) ->> 'changed')")/$(q "$STATE")/$(q "SELECT (SELECT count(*) FROM public.partner_return_cohort) || '/' || (SELECT cutoff_at FROM public.partner_return_policy)")" \
  "true/default=none gate=1 notes=2 cron=2 on=true ready=true cutoff=set rb_audit=1/$(echo "$K0" | cut -d/ -f1)/$(echo "$K0" | cut -d/ -f5)"
check "A6 (T2) Phase 1 re-applied: the investor move refusal is back (body + trigger), the move is refused again"   "$(q "$CARRY")/$(SRMOVE RB-2 rbmove)" "true/true/42501"

# The switch off but release_ready still set: the rollback clears it (and audits that).
q "SELECT public.set_partner_return_policy(false)" >/dev/null
rc=$(runf "$RB1" rb1_run3)
check "A7 switch off, release_ready set: the rollback clears release_ready and audits it" "$rc/$(q "$STATE")" \
  "0/default=15 gate=0 notes=0 cron=0 on=false ready=false cutoff=set rb_audit=2"
rc=$(runf "$RB1" rb1_run4)
check "A7 ... and a second run writes nothing" "$rc/$(q "$STATE")" "0/default=15 gate=0 notes=0 cron=0 on=false ready=false cutoff=set rb_audit=2"

echo "== B. Both phases, newest first"
stub race_stub.sql race_stub_phase2.sql
apply "$MIG1"; apply "$MIG2"
q "UPDATE public.partner_return_policy SET release_ready = true; SELECT public.set_partner_return_policy(true);" >/dev/null
rc=$(runf "$RB2" rb2_on)
check "B1 Phase 2 rollback while the switch is on: refused, nothing changed" \
  "$rc/$(grep -c PHASE2_ROLLBACK_SWITCH_ON "$OUT/rb2_on")/$(q "SELECT enabled || '/' || release_ready FROM public.partner_return_policy")/$(q "SELECT count(*) FROM pg_proc WHERE proname = 'partner_rate_now'")" \
  "3/1/true/true/1"
q "SELECT public.set_partner_return_policy(false)" >/dev/null
# Phase 6 F6: the operator's psql on Windows may talk WIN1252 (no PGCLIENTENCODING). The Phase 2 rollback sets
# client_encoding UTF8 itself right after BEGIN, so the 22 restored production texts (one has an em dash) are stored
# byte for byte and its step 5a md5 check passes. This run uses WIN1252 on purpose.
rc=$(PGCLIENTENCODING=WIN1252 runf "$RB2" rb2_run1)
if [ "$rc" != 0 ]; then note "B2 Phase 2 rollback output: $(grep -m3 -E 'ERROR|FAIL' "$OUT/rb2_run1" | tr -d '\r' | tr '\n' ' ' | cut -c1-400)"; fi
check "B2 Phase 2 rollback with the switch off: runs (its own verify block passes), release_ready cleared, Phase 2 functions gone" \
  "$rc/$(q "SELECT enabled || '/' || release_ready FROM public.partner_return_policy")/$(q "SELECT count(*) FROM pg_proc WHERE proname IN ('partner_rate_now', 'partner_quote_rate', 'partner_note_linked_late', 'agent_create_promissory_notes_split')")" \
  "0/false/false/0"
check "B2 (Phase 6 F6) ... run with PGCLIENTENCODING=WIN1252: production's hr_pay_post_staff_reinvestment restored byte for byte (md5 ed4cc123..., not the mojibake 8d0961a4...), no 5a refusal"   "$(q "SELECT md5(pg_get_functiondef('public.hr_pay_post_staff_reinvestment(uuid)'::regprocedure))")/$(grep -c 'client_encoding' "$OUT/rb2_run1")"   "ed4cc123465f945d282e109f8770a22b/0"
check "B2 ... the round-3/4 helpers _promissory_note_rate_json and _promissory_note_notice_contacts are gone; Phase 1's partner_rate_lock stays (Phase 1 keeps its functions), closed and working" \
  "$(q "SELECT count(*) FROM pg_proc WHERE proname IN ('_promissory_note_rate_json', '_promissory_note_notice_contacts')")/$(q "SELECT count(*) || '/' || COALESCE(max(proacl::text), 'default') FROM pg_proc WHERE oid = to_regprocedure('public.partner_rate_lock(uuid[])')")/$(q "SELECT 'ok' FROM (SELECT public.partner_rate_lock(ARRAY[gen_random_uuid()])) x")" \
  "0/1/{postgres=X/postgres}/ok"
check "B2 ... the Phase 1 gate still calls partner_rate_lock, and the restored note RPCs return production's shape again (to_jsonb(v_note), no helper)" \
  "$(q "SELECT (position('public.partner_rate_lock(ARRAY[NEW.investor_id])' in pg_get_functiondef('public.enforce_partner_return_rate_policy()'::regprocedure)) > 0)::text")/$(q "SELECT count(*) FROM pg_proc WHERE proname IN ('agent_create_promissory_note', 'agent_create_promissory_note_for_houses') AND prosrc LIKE '%_promissory_note_rate_json%'")" \
  "true/0"
check "B2 ... (round 4) no function calls _promissory_note_notice_contacts any more (the notice queues use the typed contacts again); the rollback drops it and its verify block names it" \
  "$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosrc LIKE '%_promissory_note_notice_contacts%'")/$(grep -c 'DROP FUNCTION IF EXISTS public._promissory_note_notice_contacts(public.promissory_notes);' "$RB2")/$(grep -c "'_promissory_note_rate_json', '_promissory_note_notice_contacts')" "$RB2")" \
  "0/1/1"
rc=$(runf "$RB2" rb2_run2)
check "B3 Phase 2 rollback again: exit 0 (idempotent)" "$rc" "0"
check "B4 with Phase 2 rolled back (release_ready cleared) the CEO cannot switch on" \
  "$(q "SELECT public.set_partner_return_policy(true)" | grep -c 'the release .* is not complete')/$(q "SELECT enabled FROM public.partner_return_policy")" "1/f"
rc=$(PGCLIENTENCODING=WIN1252 runf "$RB1" rb1_after_rb2)
check "B5 then the Phase 1 rollback (Phase 6 F6: run with PGCLIENTENCODING=WIN1252): runs, switch off, release_ready false (already off and cleared: no rollback audit row)" "$rc/$(q "$STATE")" \
  "0/default=15 gate=0 notes=0 cron=0 on=false ready=false cutoff=set rb_audit=0"
check "B5 ... after both rollbacks partner_rate_lock is still there (Phase 1 keeps its functions), _promissory_note_rate_json and _promissory_note_notice_contacts are not" \
  "$(q "SELECT count(*) FROM pg_proc WHERE proname = 'partner_rate_lock'")/$(q "SELECT count(*) FROM pg_proc WHERE proname IN ('_promissory_note_rate_json', '_promissory_note_notice_contacts')")" "1/0"
check "B5 (round 5; round 6: the 4-argument one, no other overload) ... and partner_note_window_applies is still there, closed (Phase 1 keeps its functions)"   "$(q "SELECT count(*) || '/' || COALESCE(max(proacl::text), 'default') FROM pg_proc WHERE oid = to_regprocedure('public.partner_note_window_applies(uuid,uuid,uuid,uuid)')")/$(q "SELECT count(*) FROM pg_proc WHERE proname = 'partner_note_window_applies'")" "1/{postgres=X/postgres}/1"
check "B5 (round 6) after both rollbacks the one-open-request index is still there (the Phase 1 rollback keeps portfolio_rate_approvals and its indexes)" \
  "$(q "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'portfolio_rate_approvals_one_open'")" "1"

check "F6 both data-forward rollbacks: BEGIN first, then client_encoding set to UTF8 among the SETs that follow it (before any other statement)"   "$(for f in "$RB1" "$RB2"; do grep -vE '^\s*(--.*)?$' "$f" | tr -d '\r' | awk 'NR==1{b=($0=="BEGIN;")} NR>1 && !/^SET /{exit} /^SET client_encoding = .UTF8.;$/{e=1} END{printf "%d%d", b, e}'; echo -n ' '; done)"   "11 11 "
echo "ROLLBACK SUMMARY $pass passed, $fail failed"
