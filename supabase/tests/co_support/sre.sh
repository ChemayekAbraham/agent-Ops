#!/usr/bin/env bash
# SRE rehearsal of the co-support migration on the throwaway local Postgres.
set -uo pipefail
S="C:/Users/USER/AppData/Local/Temp/claude/687f05eb529ad92c/a1fdda05-4906-4282-adaf-8aee51ff8509/scratchpad/cosup"
PSQL="C:/Program Files/PostgreSQL/18/bin/psql.exe"
W="C:/Users/USER/Documents/projects/lovable/welilereceipts-com-98bba33b/.claude/worktrees/selftopup/supabase"
MIG="$W/migrations/20261115090000_co_support_phase1.sql"
RB="$W/rollbacks/20261115090000_co_support_phase1.rollback.sql"
q()  { "$PSQL" -h localhost -p 55432 -U postgres -d cosup_test -X -q -At -v ON_ERROR_STOP=1 "$@" 2>&1 | tr -d '\r'; }
ms() { date +%s%3N; }
FAIL=0; ok() { echo "  ok   $1"; }; bad() { echo "  FAIL $1"; FAIL=1; }

FP="select md5(string_agg(x, '|' order by x)) from (
  select p.proname || ':' || md5(p.prosrc) || ':' || coalesce(array_to_string(p.proacl, ','), '') as x from pg_proc p
   where p.oid in ('public.psm_disburse_landlord_float(uuid,uuid,uuid[])'::regprocedure,
                   'public.psm_activate_line_on_disbursement()'::regprocedure,
                   'public.funder_pending_hold(uuid)'::regprocedure,
                   'public.psm_release_self_funding_line(uuid,text)'::regprocedure,
                   'public.psm_release_plan_on_line_cancel()'::regprocedure)
  union all select 'view:' || md5(pg_get_viewdef('public.v_partner_self_fundable_plans'::regclass))
  union all select 'viewcomment:' || coalesce(obj_description('public.v_partner_self_fundable_plans'::regclass), '')
  union all select 'idx:' || pg_get_indexdef(indexrelid) from pg_index where indrelid = 'public.partner_self_funding_lines'::regclass
  union all select 'col:' || attname from pg_attribute where attrelid = 'public.partner_self_funding_lines'::regclass and attnum > 0 and not attisdropped
  union all select 'trg:' || tgname from pg_trigger where tgrelid = 'public.partner_self_funding_lines'::regclass and not tgisinternal
  union all select 'tbl:' || relname from pg_class where relname = 'co_support_invites'
  union all select 'fn:' || proname from pg_proc where proname like '%co_support%') s"

echo "== E1 Lock inventory while the migration runs (held until COMMIT)"
NOMIG=1 bash "$S/reset.sh" >/dev/null
cat > "$S/e1.sql" <<EOF
BEGIN;
\i $MIG
SELECT c.relname || ' ' || string_agg(DISTINCT l.mode, ',') FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
 WHERE l.pid = pg_backend_pid() AND c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','v')
 GROUP BY c.relname ORDER BY 1;
ROLLBACK;
EOF
q -f "$S/e1.sql" | grep -v '^$' | grep -vi 'notice' | sed 's/^/       /'

echo "== E2 A long transaction on rent_requests: migration gives up after lock_timeout, leaves nothing"
NOMIG=1 bash "$S/reset.sh" >/dev/null
BASE_FP=$(q -c "$FP")
( "$PSQL" -h localhost -p 55432 -U postgres -d cosup_test -X -q -c "BEGIN; UPDATE rent_requests SET updated_at = now() WHERE false; SELECT pg_sleep(12); COMMIT;" >/dev/null 2>&1 ) &
sleep 1
T0=$(ms); OUT=$(q -1 -f "$MIG"); T1=$(ms)
wait
if echo "$OUT" | grep -q "lock timeout" && [ "$(q -c "$FP")" = "$BASE_FP" ]; then
  ok "migration stopped after $((T1-T0)) ms with: $(echo "$OUT" | grep -o 'canceling statement due to lock timeout' | head -1); database unchanged"
else bad "E2: $OUT"; fi

echo "== E3 Apply / rollback timing at volume (20,000 plans, 2,000 cart holds)"
NOMIG=1 bash "$S/reset.sh" >/dev/null
q -c "insert into landlords (id, name) values ('00000000-0000-0000-0000-0000000000aa', 'L');
      insert into profiles (id, full_name) values ('00000000-0000-0000-0000-0000000000bb', 'Agent A');
      insert into rent_requests (tenant_id, agent_id, landlord_id, rent_amount)
      select gen_random_uuid(), '00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-0000000000aa', 100000 + (g % 50) * 10000
        from generate_series(1, 20000) g;
      insert into partner_self_plan_claims (rent_request_id, partner_id, amount, expires_at)
      select id, gen_random_uuid(), rent_amount, now() + interval '1 hour' from rent_requests limit 2000;
      analyze;" >/dev/null
BASE_FP=$(q -c "$FP")
VIEW_BEFORE=$(q -c "explain (analyze, format json) select count(*) from v_partner_self_fundable_plans" | grep -o '"Execution Time": [0-9.]*' | grep -o '[0-9.]*$')
T0=$(ms); q -1 -f "$MIG" >/dev/null; T1=$(ms)
APPLY=$((T1-T0))
# 300 open invites on the list, then time the view again
q -c "insert into co_support_invites (code, rent_request_id, lead_partner_id, rent_amount, gross_amount, lead_rent, invitee_rent, lead_share, invitee_share, expires_at)
      select upper(substr(md5(id::text),1,12)), id, gen_random_uuid(), 300000, 306000, 150000, 150000, 153000, 153000, now() + interval '48 hours'
        from rent_requests offset 5000 limit 300; analyze;" >/dev/null
VIEW_AFTER=$(q -c "explain (analyze, format json) select count(*) from v_partner_self_fundable_plans" | grep -o '"Execution Time": [0-9.]*' | grep -o '[0-9.]*$')
LISTED=$(q -c "select count(*) from v_partner_self_fundable_plans")
q -c "delete from co_support_invites" >/dev/null
T0=$(ms); RBOUT=$(q -1 -f "$RB"); T1=$(ms)
RBMS=$((T1-T0))
echo "       apply ${APPLY} ms (whole file, one transaction); rollback ${RBMS} ms"
echo "       fundable-plans view: ${VIEW_BEFORE} ms before, ${VIEW_AFTER} ms after with 300 open invites ($LISTED of 20,000 listed)"
[ "$(q -c "$FP")" = "$BASE_FP" ] && ok "E3 rollback restored every changed object exactly (bodies, grants, view, indexes, column, triggers)" || bad "E3 rollback fingerprint differs: $RBOUT"

echo "== E4 Re-apply after rollback, double apply, then the full test suites"
q -1 -f "$MIG" >/dev/null && q -1 -f "$MIG" >/dev/null && ok "E4 applies again after rollback, and a second apply on top is harmless" || bad "E4 re-apply"
bash "$S/reset.sh" >/dev/null
R1=$(q -f "$S/test.sql" | grep -c 'ALL FUNCTIONAL TESTS PASSED')
[ "$R1" = 1 ] && ok "E4 functional suite (test.sql) passes" || bad "E4 test.sql"

echo "== E5 Rollback refuses while a co-supported plan has live funding"
OUT=$(q -1 -f "$RB")
echo "$OUT" | grep -q ROLLBACK_REFUSED && [ "$(q -c "select count(*) from co_support_invites")" -gt 0 ] && ok "E5 refused; data untouched" || bad "E5: $OUT"

echo "== E6 Real roles: anon can preview only; signed-in can call the 8 functions but not the helpers or the table"
OUT=$(q -c "set role anon; select co_support_preview('nothing')->>'found';")
[ "$OUT" = "false" ] && ok "E6 anon preview works" || bad "E6 anon preview: $OUT"
OUT=$(q -c "set role anon; select co_support_create(gen_random_uuid());")
echo "$OUT" | grep -q "permission denied" && ok "E6 anon create: permission denied" || bad "E6 anon create: $OUT"
OUT=$(q -c "set role authenticated; select * from co_support_invites limit 1;")
echo "$OUT" | grep -q "permission denied" && ok "E6 signed-in table read: permission denied" || bad "E6 table: $OUT"
OUT=$(q -c "set role authenticated; select _co_support_open_half(gen_random_uuid(), gen_random_uuid(), 1, 1, 'x');")
echo "$OUT" | grep -q "permission denied" && ok "E6 signed-in helper call: permission denied" || bad "E6 helper: $OUT"

echo "== E7 Latency (stub database: lower bound, production has heavier ledger triggers)"
cat > "$S/e7.sql" <<'EOF'
DO $$
DECLARE i int; a uuid; b uuid; p uuid; l uuid; r jsonb; t0 timestamptz; acc numeric[] := '{}'; pre numeric[] := '{}'; cr numeric[] := '{}';
BEGIN
  INSERT INTO landlords (name) VALUES ('L') RETURNING id INTO l;
  FOR i IN 1..40 LOOP
    a := gen_random_uuid(); b := gen_random_uuid();
    INSERT INTO profiles (id, full_name) VALUES (a, 'A x'), (b, 'B y');
    INSERT INTO t_partners (user_id) VALUES (a), (b);
    INSERT INTO general_ledger (amount, direction, category, user_id, source_table, ledger_scope, wallet_bucket)
    VALUES (200000, 'cash_in', 'float_deposit', a, 't', 'wallet', 'float'), (200000, 'cash_in', 'float_deposit', b, 't', 'wallet', 'float');
    INSERT INTO rent_requests (tenant_id, agent_id, landlord_id, rent_amount) VALUES (gen_random_uuid(), gen_random_uuid(), l, 300000) RETURNING id INTO p;
    PERFORM set_config('request.jwt.claim.sub', a::text, false);
    t0 := clock_timestamp(); r := co_support_create(p); cr := cr || extract(epoch from clock_timestamp() - t0) * 1000;
    PERFORM set_config('request.jwt.claim.sub', b::text, false);
    t0 := clock_timestamp(); PERFORM co_support_preview(r->>'code'); pre := pre || extract(epoch from clock_timestamp() - t0) * 1000;
    t0 := clock_timestamp(); PERFORM co_support_accept(r->>'code'); acc := acc || extract(epoch from clock_timestamp() - t0) * 1000;
  END LOOP;
  RAISE WARNING 'create p50 % ms p95 % ms | preview p50 % ms p95 % ms | accept p50 % ms p95 % ms',
    (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY x)::numeric, 1) FROM unnest(cr) x),
    (SELECT round(percentile_cont(0.95) WITHIN GROUP (ORDER BY x)::numeric, 1) FROM unnest(cr) x),
    (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY x)::numeric, 1) FROM unnest(pre) x),
    (SELECT round(percentile_cont(0.95) WITHIN GROUP (ORDER BY x)::numeric, 1) FROM unnest(pre) x),
    (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY x)::numeric, 1) FROM unnest(acc) x),
    (SELECT round(percentile_cont(0.95) WITHIN GROUP (ORDER BY x)::numeric, 1) FROM unnest(acc) x);
END $$;
SELECT 'integrity rows: ' || count(*) FROM co_support_integrity_check();
EOF
q -f "$S/e7.sql" | sed 's/^psql.*WARNING: */       /'

[ $FAIL = 0 ] && echo "ALL SRE CHECKS PASSED" || echo "SRE CHECKS FAILED"
