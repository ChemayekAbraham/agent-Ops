#!/usr/bin/env bash
# Phase 4 (Partner Returns: 4a, 4a-assistant, 4b) SQL tests against a THROWAWAY local Postgres on port 55432 (design v2
# §10.3, P1-P12). Never point this at production: race_stub.sql drops and recreates the public, auth and cron schemas.
#
#   bash run_phase4_tests.sh              # functional + race + rollback + grants (production default ACL)
#   bash run_phase4_tests.sh functional   # load + phase4_test.sql (P1, P3-P9, P11, P12, the §2.7 amendments) + P7 grants,
#                                         # then phase4_fix_test.sql, phase4_round3_test.sql and phase4_round4_test.sql, each on a fresh load
#   bash run_phase4_tests.sh race|rollback|grants
#   bash run_phase4_tests.sh phase6     # Phase 6 fix round (F1-F5) unit checks: phase6_fix_test.sql on a fresh load, then the
#                                       # F2 concurrency check (a bulk late link does not block an unrelated person's portfolio)
#   bash run_phase4_tests.sh revchain   # Phase 6 F6: full load + reverse rollback chain (4b, 4a-assistant, 4a, 2, 1) with
#                                       # PGCLIENTENCODING=WIN1252, REVCHAIN_N times (default 10); round 1 runs the chain twice
#   bash run_phase4_tests.sh e2e        # Phase 6 end-to-end persona suite (e2e_scenarios.sql) in three modes on three throwaway
#                                       # databases ${PGDB_E2E}_on|_never|_base (default p4e2e), then never-vs-base production parity
#   ('all' runs every target above, dryrun included.)
#
# Load = race_stub.sql + race_stub_phase2.sql + race_stub_phase4.sql + race_stub_phase4_fix.sql, production's link functions,
# profile triggers and trust impl verbatim (prod_link_functions.sql, prod_trust_impl.sql), the five production readers (the 4b rollback file,
# which checks their md5 against the manifest), phase4_prod_copies.sql, Phase 1 x2, Phase 2 x2, phase4_before_4a.sql,
# 4a x2 (phase4_between_applies.sql in between), 4a-assistant x2, 4b x2. Every file: single transaction, ON_ERROR_STOP.
# The functional, race and rollback steps use the database $PGDB (default postgres); 'grants' loads a second throwaway
# database ($PGDB_ACL, default p4test_acl) with production's default function ACL (new functions: owner and service_role
# only) and drops it afterwards (default privileges are per database, so they never reach $PGDB).
#
# Environment: PGBIN (default "C:/Program Files/PostgreSQL/18/bin"), PGPORT (55432), PGDB, PGDB_ACL,
#              PGDATA_DIR (optional: initdb + start a cluster there if nothing listens on PGPORT),
#              MIG1 / MIG2 / MIG4A / MIG4AS / MIG4B, RB4A / RB4AS / RB4B (default: the files in supabase/).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$DIR/../.."
PGBIN="${PGBIN:-C:/Program Files/PostgreSQL/18/bin}"
PORT="${PGPORT:-55432}"
PSQL="$PGBIN/psql"; [ -x "$PSQL.exe" ] && PSQL="$PSQL.exe"
PGDB="${PGDB:-postgres}"
PGDB_ACL="${PGDB_ACL:-p4test_acl}"
MIG1="${MIG1:-$ROOT/migrations/20261105150000_partner_return_policy_phase1.sql}"
MIG2="${MIG2:-$ROOT/migrations/20261105151000_partner_return_policy_phase2.sql}"
MIG4A="${MIG4A:-$ROOT/migrations/20261107100000_partner_return_policy_phase4.sql}"
MIG4AS="${MIG4AS:-$ROOT/migrations/20261107100500_assistant_partner_new_portfolio_rate.sql}"
MIG4B="${MIG4B:-$ROOT/pending/20261107101000_partner_return_policy_phase4_masks.sql}"
RB4A="${RB4A:-$ROOT/rollbacks/20261107100000_partner_return_policy_phase4.rollback.sql}"
RB4AS="${RB4AS:-$ROOT/rollbacks/20261107100500_assistant_partner_new_portfolio_rate.rollback.sql}"
RB4B="${RB4B:-$ROOT/rollbacks/20261107101000_partner_return_policy_phase4_masks.rollback.sql}"
# Phase 6 F6: the migrations and rollbacks carry UTF-8 text (an em dash in a restored production function); psql on
# Windows otherwise talks WIN1252. The rollback suites also run one rollback with WIN1252 on purpose.
export PGCLIENTENCODING="${PGCLIENTENCODING:-UTF8}"
export PSQL PORT PGDB
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }
PD() { local db="$1"; shift; "$PSQL" -h localhost -p "$PORT" -U postgres -d "$db" -X -q "$@"; }
P() { PD "$PGDB" "$@"; }
WHAT="${1:-all}"

if ! "$PGBIN/pg_isready" -h localhost -p "$PORT" -q; then
  [ -n "${PGDATA_DIR:-}" ] || { echo "Nothing listens on $PORT and PGDATA_DIR is not set"; exit 2; }
  [ -f "$PGDATA_DIR/PG_VERSION" ] || "$PGBIN/initdb" -D "$PGDATA_DIR" -U postgres --auth=trust -E UTF8 --no-locale >/dev/null
  "$PGBIN/pg_ctl" -D "$PGDATA_DIR" -o "-p $PORT" -l "$PGDATA_DIR/server.log" -w start >/dev/null
fi

apply() { # $1 = db, $2 = file, $3 = label
  if PD "$1" -v ON_ERROR_STOP=1 -1 -f "$2" >/dev/null 2>"$DIR/out_mig4.err"; then
    echo "PASS  $(basename "$2") apply $3 (single transaction, ON_ERROR_STOP)"
    grep -h WARNING "$DIR/out_mig4.err" | sed 's/^/      /' | head -3
  else echo "FAIL  $(basename "$2") apply $3: $(grep -m1 -A1 ERROR "$DIR/out_mig4.err" | tr '\n' ' ')"; exit 1; fi
}
step() { # $1 = db, $2 = file, $3 = expected marker line
  PD "$1" -v ON_ERROR_STOP=1 -1 -At -f "$2" 2>&1 | tr -d '\r' | grep -q "$3" || { echo "FAIL  $(basename "$2") did not run"; exit 1; }
}
load() { # $1 = db, $2 = 'acl' for production's default function ACL
  local db="$1"
  for f in race_stub.sql race_stub_phase2.sql race_stub_phase4.sql; do
    PD "$db" -v ON_ERROR_STOP=1 -1 -f "$DIR/$f" 2>&1 | grep -vE "NOTICE|DETAIL|drop cascades|already a member|other objects"
    [ "${PIPESTATUS[0]}" = 0 ] || { echo "FAIL  $f did not load"; exit 1; }
  done
  # The Phase 4 fix stand-ins (contact-proof tables, auth.identities, what production's trust impl reads), then
  # production's profile-driven note linking and _get_user_trust_profile_impl VERBATIM (each file checks its md5).
  step "$db" "$DIR/race_stub_phase4_fix.sql" 'stub phase4 fix ready'
  step "$db" "$DIR/prod_link_functions.sql" 'prod link functions ready'
  step "$db" "$DIR/prod_trust_impl.sql" 'prod trust impl ready'
  if [ "${2:-}" = acl ]; then
    # Production (since 2026-10-19): a function created in public is callable only by its owner and service_role.
    PD "$db" -v ON_ERROR_STOP=1 -c "ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC" \
       -c "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role" >/dev/null \
      && echo "PASS  production default function ACL set on $db (owner + service_role)"
  fi
  { printf 'CREATE TABLE public._t_manifest AS SELECT $m$'; tr -d '\r' < "$DIR/prod_function_manifest.json"; printf '$m$::jsonb AS doc;\n'; } \
    | PD "$db" -v ON_ERROR_STOP=1 >/dev/null || { echo "FAIL  manifest did not load"; exit 1; }
  apply "$db" "$RB4B" "(production readers, md5 = manifest)"
  step "$db" "$DIR/phase4_prod_copies.sql" 'prod copies ready'
  apply "$db" "$MIG1" "#1"; apply "$db" "$MIG1" "#2"
  apply "$db" "$MIG2" "#1"; apply "$db" "$MIG2" "#2"
  step "$db" "$DIR/phase4_before_4a.sql" 'before 4a ready'
  apply "$db" "$MIG4A" "#1"
  step "$db" "$DIR/phase4_between_applies.sql" 'between 4a applies ready'
  apply "$db" "$MIG4A" "#2"
  apply "$db" "$MIG4AS" "#1"; apply "$db" "$MIG4AS" "#2"
  apply "$db" "$MIG4B" "#1"; apply "$db" "$MIG4B" "#2"
  PD "$db" -v ON_ERROR_STOP=1 -c "CREATE TABLE public._t_fn_after AS SELECT DISTINCT p.proname::text AS proname FROM pg_proc p
                                  JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'" >/dev/null
  rm -f "$DIR/out_mig4.err"
}
grants() { # $1 = db, $2 = label
  ( cd "$DIR" && PD "$1" -v ACL_LABEL="$2" -f "$DIR/phase4_grants_test.sql" >"$DIR/out_phase4_grants_$2.txt" 2>"$DIR/out_phase4_grants_$2.err" )
  grep -E '^(PASS|FAIL|INFO|SUMMARY)' "$DIR/out_phase4_grants_$2.txt"
  if grep -q ERROR "$DIR/out_phase4_grants_$2.err"; then echo "UNEXPECTED ERRORS:"; grep -B1 -A3 ERROR "$DIR/out_phase4_grants_$2.err"; fi
}

if [ "$WHAT" = all ] || [ "$WHAT" = functional ]; then
  echo "== Phase 4 load ($PGDB)"
  load "$PGDB"
  echo "== P7 grants (stub default ACL)"
  grants "$PGDB" stub_acl
  echo "== Phase 4 functional tests"
  ( cd "$DIR" && P -v MIG1="$(winpath "$MIG1")" -v MIG2="$(winpath "$MIG2")" -v RB4B="$(winpath "$RB4B")" \
      -f "$DIR/phase4_test.sql" >"$DIR/out_phase4.txt" 2>"$DIR/out_phase4.err" )
  grep -E '^(PASS|FAIL|INFO|SUMMARY)' "$DIR/out_phase4.txt"
  if grep -q ERROR "$DIR/out_phase4.err"; then echo "UNEXPECTED ERRORS:"; grep -B1 -A3 ERROR "$DIR/out_phase4.err"; fi
  echo "== Phase 4 fix-round tests (S1-S7, fresh load of $PGDB; production's link functions, profile triggers and trust impl)"
  load "$PGDB" >/dev/null
  ( cd "$DIR" && P -f "$DIR/phase4_fix_test.sql" >"$DIR/out_phase4_fix.txt" 2>"$DIR/out_phase4_fix.err" )
  grep -E '^(PASS|FAIL|INFO|SUMMARY)' "$DIR/out_phase4_fix.txt"
  if grep -q ERROR "$DIR/out_phase4_fix.err"; then echo "UNEXPECTED ERRORS:"; grep -B1 -A3 ERROR "$DIR/out_phase4_fix.err"; fi
  echo "== Phase 4 round-3 tests (Q1-Q8: reviewers' attacks + controls; fresh load of $PGDB; the REAL security migration 20261106200000)"
  load "$PGDB" >/dev/null
  ( cd "$DIR" && P -f "$DIR/phase4_round3_test.sql" >"$DIR/out_phase4_round3.txt" 2>"$DIR/out_phase4_round3.err" )
  grep -E '^(PASS|FAIL|INFO|SUMMARY)' "$DIR/out_phase4_round3.txt"
  if grep -q ERROR "$DIR/out_phase4_round3.err"; then echo "UNEXPECTED ERRORS:"; grep -B1 -A3 ERROR "$DIR/out_phase4_round3.err"; fi
  echo "== Phase 4 round-4 tests (T1-T4: closed-note links held, investor moves after the cut-off, release-check strength, held-event source; fresh load of $PGDB)"
  load "$PGDB" >/dev/null
  ( cd "$DIR" && P -f "$DIR/phase4_round4_test.sql" >"$DIR/out_phase4_round4.txt" 2>"$DIR/out_phase4_round4.err" )
  grep -E '^(PASS|FAIL|INFO|SUMMARY)' "$DIR/out_phase4_round4.txt"
  if grep -q ERROR "$DIR/out_phase4_round4.err"; then echo "UNEXPECTED ERRORS:"; grep -B1 -A3 ERROR "$DIR/out_phase4_round4.err"; fi
fi

if [ "$WHAT" = all ] || [ "$WHAT" = race ]; then
  echo "== P2 activation race"
  load "$PGDB" >/dev/null
  bash "$DIR/race_run_phase4.sh" | tee "$DIR/out_race_phase4.txt"
fi

if [ "$WHAT" = all ] || [ "$WHAT" = rollback ]; then
  echo "== P10 rollback (4b, 4a-assistant, 4a) and re-apply"
  load "$PGDB" >/dev/null
  RB() { # $1 = file, $2 = label, $3 = expect ok|refused, $4 = refusal text
    if P -v ON_ERROR_STOP=1 -1 -f "$1" >/dev/null 2>"$DIR/out_rb4.err"; then
      if [ "$3" = ok ]; then echo "PASS  P10 $2"; else echo "FAIL  P10 $2: applied, expected a refusal"; fi
    else
      if [ "$3" = refused ] && grep -q "$4" "$DIR/out_rb4.err"; then echo "PASS  P10 $2"
      else echo "FAIL  P10 $2: $(grep -m1 ERROR "$DIR/out_rb4.err")"; fi
    fi
  }
  RB "$RB4A" "the 4a rollback refuses while 4b is applied (its readers call partner_rate_visible_to_caller)" refused "4a rollback refused: roll back 4b first"
  # S8: the 4b rollback refuses while the switch is on or release_ready is set (each inside a rolled-back transaction;
  # the policy guard trigger is off for the stand-in only).
  for st in "release_ready = true" "enabled = true" "enabled = true, release_ready = true, cutoff_at = now()"; do
    out=$( { echo "BEGIN;"; echo "ALTER TABLE public.partner_return_policy DISABLE TRIGGER trg_partner_return_policy_guard;";
             echo "UPDATE public.partner_return_policy SET $st;";
             echo "ALTER TABLE public.partner_return_policy ENABLE TRIGGER trg_partner_return_policy_guard;";
             echo "\\i '$(winpath "$RB4B")'"; echo "ROLLBACK;"; } | P -At 2>&1 | tr -d '\r')
    if echo "$out" | grep -q "4b rollback refused: Partner Returns is on or release-ready"; then echo "PASS  P10 (S8) the 4b rollback refuses while $st"
    else echo "FAIL  P10 (S8) the 4b rollback while $st: $(echo "$out" | grep -m1 ERROR)"; fi
  done
  [ "$(P -At -c "SELECT count(*) FROM pg_proc WHERE prosrc LIKE '%Partner Returns Phase 4b%' AND proname IN ('get_user_trust_profile','get_public_trust_profile','get_partner_wallet_hub','agent_onboarded_portfolios','get_portfolio_by_activation_token')" | tr -d '\r')" = 5 ] \
    && echo "PASS  P10 (S8) after the refused rollbacks the five 4b readers are still masked" || echo "FAIL  P10 (S8) a refused 4b rollback changed a reader"
  RB "$RB4B" "4b rollback applies (its own md5 check against the production fingerprints passes)" ok
  RB "$RB4AS" "4a-assistant rollback applies" ok
  RB "$RB4A" "4a rollback applies after 4b's (switch off, no cut-off: no warning)" ok
  grep -q WARNING "$DIR/out_rb4.err" && echo "FAIL  P10 the 4a rollback warned before any cut-off: $(grep -m1 WARNING "$DIR/out_rb4.err")"
  ( cd "$DIR" && P -v PHASE=rolled_back -f "$DIR/phase4_rollback_check.sql" 2>&1 ) | tr -d '\r' | grep -E '^(PASS|FAIL|SUMMARY)|ERROR'
  # 4b's own guard, inside rolled-back transactions: $1 = SQL run first, $2 = expected error text, $3 = label
  refuse4b() {
    local out
    out=$( { echo "BEGIN;"; echo "$1"; echo "\\i '$(winpath "$MIG4B")'"; echo "ROLLBACK;"; } | P -At 2>&1 | tr -d '\r')
    if echo "$out" | grep -q "$2"; then echo "PASS  P10 $3"; else echo "FAIL  P10 $3: $(echo "$out" | grep -m1 ERROR)"; fi
  }
  refuse4b "SELECT 1;" "4b needs 4a (partner_rate_visible_to_caller is missing)" "4b refuses to run without 4a"
  apply "$PGDB" "$MIG4A" "#1 after the rollback"; apply "$PGDB" "$MIG4A" "#2 after the rollback"
  refuse4b "DO \$x\$ BEGIN EXECUTE replace(pg_get_functiondef('public.get_user_trust_profile(text)'::regprocedure), 'RETURN public._get_user_trust_profile_impl(v_user_id);', 'RETURN public._get_user_trust_profile_impl(v_user_id); -- changed in production since'); END \$x\$;" \
    "4b refuses: these readers differ from the production text it was built on: public.get_user_trust_profile(text)" \
    "4b refuses when a reader changed in production since it was built (md5 differs, no 4b marker), naming the reader"
  apply "$PGDB" "$MIG4AS" "#1 after the rollback"; apply "$PGDB" "$MIG4B" "#1 after the rollback"; apply "$PGDB" "$MIG4B" "#2 after the rollback"
  ( cd "$DIR" && P -v PHASE=reapplied -f "$DIR/phase4_rollback_check.sql" 2>&1 ) | tr -d '\r' | grep -E '^(PASS|FAIL|SUMMARY)|ERROR'
  # After the first switch-on the old activate-promissory-note cannot link notes (Phase 1 guard): the 4a rollback warns.
  # A cut-off stand-in inside a rolled-back transaction (the guard trigger is off for the stand-in only).
  out=$( { echo "BEGIN;";
           echo "ALTER TABLE public.partner_return_policy DISABLE TRIGGER trg_partner_return_policy_guard;";
           echo "UPDATE public.partner_return_policy SET cutoff_at = now();";
           echo "ALTER TABLE public.partner_return_policy ENABLE TRIGGER trg_partner_return_policy_guard;";
           echo "\\i '$(winpath "$RB4B")'"; echo "\\i '$(winpath "$RB4A")'";
           echo "SELECT 'GONE ' || (to_regprocedure('public.activate_promissory_note(text)') IS NULL);";
           echo "ROLLBACK;"; } | P -v ON_ERROR_STOP=1 -At 2>&1 | tr -d '\r')
  if echo "$out" | grep -q 'WARNING:  4a rollback after the Partner Returns cut-off' && echo "$out" | grep -q '^GONE true'; then
    echo "PASS  P10 after a cut-off the 4a rollback still applies and warns that Partner Ops must link notes (rolled back)"
  else echo "FAIL  P10 4a rollback after a cut-off: $out"; fi
  rm -f "$DIR/out_rb4.err"
fi

if [ "$WHAT" = all ] || [ "$WHAT" = dryrun ]; then
  # Local rehearsal of prod_dryrun_phase4.sql (the production run needs the owner's go-ahead): a database with the stubs,
  # the production readers and production's default ACL, then BEGIN; part A; Phase 1; Phase 2; 4a; 4a-assistant; 4b;
  # part B; ROLLBACK. A2/A3 read production function texts the stubs do not have, so they fail here by design.
  echo "== prod_dryrun_phase4.sql rehearsed locally ($PGDB_ACL, dropped afterwards)"
  PD postgres -c "DROP DATABASE IF EXISTS $PGDB_ACL" -c "CREATE DATABASE $PGDB_ACL" >/dev/null 2>&1
  for f in race_stub.sql race_stub_phase2.sql race_stub_phase4.sql race_stub_phase4_fix.sql prod_link_functions.sql prod_trust_impl.sql; do
    PD "$PGDB_ACL" -v ON_ERROR_STOP=1 -1 -f "$DIR/$f" >/dev/null 2>&1; done
  PD "$PGDB_ACL" -c "ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC" \
     -c "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role" >/dev/null
  PD "$PGDB_ACL" -v ON_ERROR_STOP=1 -1 -f "$RB4B" >/dev/null 2>&1 || echo "FAIL  dry-run rehearsal: production readers did not load"
  partb=$(grep -n '^-- =* PART B' "$DIR/prod_dryrun_phase4.sql" | cut -d: -f1)
  out=$( { echo "BEGIN;"; echo "SET LOCAL statement_timeout = '60s';"; head -n $((partb - 1)) "$DIR/prod_dryrun_phase4.sql";
           for f in "$MIG1" "$MIG2" "$MIG4A" "$MIG4AS" "$MIG4B"; do cat "$f"; echo; done;
           tail -n +"$partb" "$DIR/prod_dryrun_phase4.sql"; } | PD "$PGDB_ACL" -At 2>&1 | tr -d '\r')
  echo "$out" | grep -E 'DRYRUN_P4|^(PASS|FAIL|INFO)  ' | sed 's/^.*DRYRUN_P4 /DRYRUN_P4 /'
  echo "$out" | grep -E '^ERROR' | grep -v DRYRUN_P4 | head -3
  PD postgres -c "DROP DATABASE IF EXISTS $PGDB_ACL" >/dev/null
fi

if [ "$WHAT" = all ] || [ "$WHAT" = grants ]; then
  echo "== P7 grants with production's default function ACL ($PGDB_ACL, dropped afterwards)"
  PD postgres -c "DROP DATABASE IF EXISTS $PGDB_ACL" -c "CREATE DATABASE $PGDB_ACL" >/dev/null
  load "$PGDB_ACL" acl | grep -E '^FAIL|default function ACL'
  grants "$PGDB_ACL" prod_acl
  PD postgres -c "DROP DATABASE IF EXISTS $PGDB_ACL" >/dev/null
fi

# ===========================================================================
# Phase 6 fix round (F1-F6) and the end-to-end persona suite
# ===========================================================================
if [ "$WHAT" = all ] || [ "$WHAT" = phase6 ]; then
  echo "== Phase 6 F5 static pins (migration and rollback files)"
  # Every forward file waits at most 1s for a lock (everything queues behind a waiting lock; retry the apply); the
  # rollbacks keep 5s. The switch-on guard waits 500ms for its SHARE lock and puts the caller's lock_timeout back.
  f5=""
  for f in "$MIG1" "$MIG2" "$MIG4A" "$MIG4B"; do f5="$f5$(grep -cE "^SET LOCAL lock_timeout = '1s';" "$f")"; done
  for f in "$ROOT/rollbacks/20261105150000_partner_return_policy_phase1.rollback.sql" "$ROOT/rollbacks/20261105151000_partner_return_policy_phase2.rollback.sql" "$RB4A" "$RB4AS" "$RB4B"; do
    f5="$f5/$(grep -cE "^SET LOCAL lock_timeout = '5s';" "$f")"; done
  [ "$f5" = "1111/1/1/1/1/1" ] && echo "PASS  F5 Phase 1, 2, 4a and 4b: SET LOCAL lock_timeout = '1s' once each; the five rollbacks keep '5s'" \
    || echo "FAIL  F5 lock_timeout lines  got [$f5] want [1111/1/1/1/1/1]"
  # Counted inside each function: Phase 6 G1 added the gate's bounded rate-lock waits to the same file.
  fnbody() { awk -v s="FUNCTION public.$1()" 'index($0, s) {f=1} f {print} f && /END [$]function[$];/ {exit}' "$MIG1"; }
  gb="$(fnbody partner_return_policy_guard)"
  g="$(grep -c "PERFORM set_config('lock_timeout', '500ms', true);" <<<"$gb")/$(grep -c "PERFORM set_config('lock_timeout', v_lt, true);" <<<"$gb")/$(grep -c "USING ERRCODE = '55P03'" <<<"$gb")"
  [ "$g" = "1/1/1" ] && echo "PASS  F5 the switch-on guard: 500ms for the SHARE lock, the caller's lock_timeout put back, 55P03 refusal" \
    || echo "FAIL  F5 switch-on guard text  got [$g] want [1/1/1]"
  eb="$(fnbody enforce_partner_return_rate_policy)"
  g="$(grep -c "PERFORM set_config('lock_timeout', '3s', true);" <<<"$eb")/$(grep -cF "PERFORM public.partner_rate_lock(ARRAY[NEW.investor_id]);" <<<"$eb")/$(grep -c "PERFORM set_config('lock_timeout', v_lt, true);" <<<"$eb")/$(grep -c "USING ERRCODE = '55P03'" <<<"$eb")/$(grep -c "v_lt::interval = interval '0' OR v_lt::interval > interval '3 seconds'" <<<"$eb")"
  [ "$g" = "3/3/3/3/3" ] && echo "PASS  G1 the gate: each of its three rate-lock calls waits at most 3s (only when the caller's lock_timeout is 0 or longer), puts the caller's lock_timeout back, refuses with 55P03" \
    || echo "FAIL  G1 gate lock-wait text  got [$g] want [3/3/3/3/3]"
  RB_DOC="$ROOT/../docs/partner-returns-10pct/runbook-bulk-links.md"
  g="$( [ -f "$RB_DOC" ] && grep -c "25 people or fewer" "$RB_DOC")/$( [ -f "$RB_DOC" ] && grep -c "06:00 to 09:30" "$RB_DOC")"
  [ "$g" = "1/1" ] && echo "PASS  G1 runbook docs/partner-returns-10pct/runbook-bulk-links.md: batches of 25 people or fewer, outside the payout windows" \
    || echo "FAIL  G1 runbook  got [$g] want [1/1]"
  c="$(grep -cE "cron.schedule\('apply-portfolio-rate-changes-705pm', '15 16 \* \* \*'" "$MIG1")/$(grep -cE "cron.schedule\('partner-rate-drift-check', '1-59/10 \* \* \* \*'" "$MIG1")"
  [ "$c" = "1/1" ] && echo "PASS  F5 cron schedules pinned in Phase 1: '15 16 * * *' (next-cycle job) and '1-59/10 * * * *' (drift check)" \
    || echo "FAIL  F5 cron schedules  got [$c] want [1/1]"
  # The switch-on needs Phase 4's release check note_browser_writes_closed: the real security migration 20261106200000.
  load_sec() { load "$1" >/dev/null
    ( cd "$DIR" && PD "$1" -v ON_ERROR_STOP=1 -1 -f "$DIR/sec_link_security_load.sql" >/dev/null 2>"$DIR/out_sec.err" )       || { echo "FAIL  the real security migration did not load: $(grep -m1 ERROR "$DIR/out_sec.err")"; exit 1; }
    rm -f "$DIR/out_sec.err"; }
  echo "== Phase 6 fix-round unit checks (F1, F2, F4, decider, conformance, cron; fresh load of $PGDB + the security migration)"
  load_sec "$PGDB"
  ( cd "$DIR" && P -f "$DIR/phase6_fix_test.sql" >"$DIR/out_phase6_fix.txt" 2>"$DIR/out_phase6_fix.err" )
  tr -d '\r' < "$DIR/out_phase6_fix.txt" | grep -E '^(PASS|FAIL|INFO|SUMMARY)'
  if grep -q ERROR "$DIR/out_phase6_fix.err"; then echo "UNEXPECTED ERRORS:"; grep -B1 -A3 ERROR "$DIR/out_phase6_fix.err"; fi
  echo "== Phase 6 F2 concurrency (fresh load of $PGDB + the security migration)"
  load_sec "$PGDB"
  bash "$DIR/race_run_phase6.sh" | tee "$DIR/out_race_phase6.txt"
fi

if [ "$WHAT" = all ] || [ "$WHAT" = revchain ]; then
  # F6: the reverse rollback chain from a full load, the way an operator on Windows runs it (psql without
  # PGCLIENTENCODING=UTF8 talks WIN1252). Each data-forward rollback sets client_encoding UTF8 itself; the Phase 2
  # rollback's step 5a compares the 22 restored production texts byte for byte (md5).
  N="${REVCHAIN_N:-10}"
  echo "== Phase 6 F6 reverse rollback chain x$N with PGCLIENTENCODING=WIN1252 (fresh load of $PGDB each time)"
  RB1F="$ROOT/rollbacks/20261105150000_partner_return_policy_phase1.rollback.sql"
  RB2F="$ROOT/rollbacks/20261105151000_partner_return_policy_phase2.rollback.sql"
  chain() { # $1 = round label; prints one line per rollback, returns 1 on the first failure
    local f opt
    for f in "$RB4B" "$RB4AS" "$RB4A" "$RB2F" "$RB1F"; do
      opt=-1; grep -q '^BEGIN;' "$f" && opt=""
      if PGCLIENTENCODING=WIN1252 PD "$PGDB" -v ON_ERROR_STOP=1 $opt -f "$f" >/dev/null 2>"$DIR/out_revchain.err"; then :
      else echo "FAIL  F6 $1: $(basename "$f"): $(grep -m1 ERROR "$DIR/out_revchain.err")"; return 1; fi
    done
  }
  ok=0
  for i in $(seq 1 "$N"); do
    load "$PGDB" >/dev/null
    if chain "round $i"; then
      st=$(P -At -c "SELECT (SELECT md5(pg_get_functiondef(to_regprocedure('public.hr_pay_post_staff_reinvestment(uuid)')))) || '/'
                    || (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_partner_return_rate_policy') || '/'
                    || (SELECT count(*) FROM pg_proc WHERE proname IN ('partner_quote_rate', 'partner_rate_visible_to_caller', 'partner_note_linked_late'))" | tr -d '\r')
      if [ "$st" = "ed4cc123465f945d282e109f8770a22b/0/0" ]; then ok=$((ok+1)); else echo "FAIL  F6 round $i: after the chain [$st] want [ed4cc123465f945d282e109f8770a22b/0/0]"; fi
      if [ "$i" = 1 ]; then
        chain "round 1, second pass (idempotent)" && echo "PASS  F6 round 1: the whole chain runs a second time cleanly (idempotent)"
      fi
    fi
  done
  [ "$ok" = "$N" ] && echo "PASS  F6 reverse chain (4b, 4a-assistant, 4a, 2, 1) with WIN1252: $ok/$N fresh loads clean; production's hr_pay_post_staff_reinvestment back byte for byte, gate and Phase 2/4 functions gone" \
    || echo "FAIL  F6 reverse chain: $ok/$N clean"
  rm -f "$DIR/out_revchain.err"
fi

if [ "$WHAT" = all ] || [ "$WHAT" = e2e ]; then
  # Phase 6 end-to-end persona suite. Three throwaway databases (never $PGDB):
  #   on     the full build + the real security migration + production's split/lock/renewal/approve texts; the CEO
  #          switches on (after the Phase 7 release step), off, on again
  #   never  the same build, switch never on: every observation must equal production's (parity below)
  #   base   no Phase 1/2/4 at all: production's own texts of the paths the suite drives (the parity baseline)
  E2E="${PGDB_E2E:-p4e2e}"
  case "$E2E" in postgres|"$PGDB") echo "FAIL  e2e: PGDB_E2E must be its own prefix"; exit 2;; esac
  OUTE="$DIR/out_e2e"; rm -rf "$OUTE"; mkdir -p "$OUTE"
  e2e_rc=0
  for mode in on never base; do
    db="${E2E}_$mode"
    echo "== Phase 6 e2e persona suite, mode $mode ($db, dropped afterwards)"
    PD postgres -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db" >/dev/null 2>&1
    if [ "$mode" = base ]; then
      for f in race_stub.sql race_stub_phase2.sql race_stub_phase4.sql race_stub_phase4_fix.sql prod_link_functions.sql prod_hr_pay_post_staff_reinvestment.sql e2e_prod_base.sql e2e_prod_extras.sql; do
        PD "$db" -v ON_ERROR_STOP=1 -1 -f "$DIR/$f" >/dev/null 2>"$OUTE/load_$mode.err" || { echo "FAIL  e2e base load: $f: $(grep -m1 ERROR "$OUTE/load_$mode.err")"; e2e_rc=1; continue 2; }
      done
    else
      load "$db" | grep -E '^FAIL'
      ( cd "$DIR" && PD "$db" -v ON_ERROR_STOP=1 -1 -f "$DIR/sec_link_security_load.sql" >/dev/null 2>"$OUTE/load_$mode.err" ) \
        || { echo "FAIL  e2e $mode: the real security migration did not load: $(grep -m1 ERROR "$OUTE/load_$mode.err")"; e2e_rc=1; continue; }
      PD "$db" -v ON_ERROR_STOP=1 -1 -f "$DIR/e2e_prod_extras.sql" >/dev/null 2>"$OUTE/load_$mode.err" \
        || { echo "FAIL  e2e $mode: e2e_prod_extras.sql: $(grep -m1 ERROR "$OUTE/load_$mode.err")"; e2e_rc=1; continue; }
    fi
    PD "$db" -v mode="$mode" -f "$DIR/e2e_scenarios.sql" >"$OUTE/$mode.txt" 2>"$OUTE/$mode.err"
    tr -d '\r' < "$OUTE/$mode.txt" | grep -E '^(PASS|FAIL|INFO|SUMMARY)' > "$OUTE/$mode.res"
    grep -E '^(FAIL|SUMMARY)' "$OUTE/$mode.res"
    if grep -q ERROR "$OUTE/$mode.err"; then echo "UNEXPECTED ERRORS ($mode):"; grep -B1 -A3 ERROR "$OUTE/$mode.err" | head -20; e2e_rc=1; fi
    grep -q '^FAIL' "$OUTE/$mode.res" && e2e_rc=1
    PD "$db" -At -c "SELECT k || '=' || COALESCE(v, '<null>') FROM public._e_obs ORDER BY k" | tr -d '\r' > "$OUTE/$mode.obs"
    [ "${KEEP_E2E:-0}" = 1 ] || PD postgres -c "DROP DATABASE IF EXISTS $db" >/dev/null 2>&1
  done
  # Production parity: every observation the switch-never-on build shares with the production baseline must be identical.
  np=0; nf=0
  while IFS= read -r line; do
    k="${line%%=*}"; v="${line#*=}"
    grep -q "^$k=" "$OUTE/base.obs" || continue
    b="$(grep -m1 "^$k=" "$OUTE/base.obs" | cut -d= -f2-)"
    if [ "$v" == "$b" ]; then np=$((np+1)); else nf=$((nf+1)); echo "FAIL  PARITY $k  never [$v] base [$b]"; fi
  done < "$OUTE/never.obs"
  echo "SUMMARY e2e parity never=base: $np identical, $nf different (of $(wc -l < "$OUTE/base.obs") baseline observations)"
  [ "$nf" = 0 ] && [ "$np" -gt 0 ] || e2e_rc=1
  echo "E2E RESULT: $([ "$e2e_rc" = 0 ] && echo 'all passed' || echo 'FAILURES above')"
fi
