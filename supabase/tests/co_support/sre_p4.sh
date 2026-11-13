#!/usr/bin/env bash
# SRE rehearsal of the Phase 4 (houses) migration on the throwaway local Postgres.
set -uo pipefail
S="C:/Users/USER/AppData/Local/Temp/claude/687f05eb529ad92c/a1fdda05-4906-4282-adaf-8aee51ff8509/scratchpad/cosup"
PSQL="C:/Program Files/PostgreSQL/18/bin/psql.exe"
W="C:/Users/USER/Documents/projects/lovable/welilereceipts-com-98bba33b/.claude/worktrees/selftopup/supabase"
MIG="$W/migrations/20261115100000_co_support_phase4_houses.sql"
RB="$W/rollbacks/20261115100000_co_support_phase4_houses.rollback.sql"
q()  { "$PSQL" -h localhost -p 55432 -U postgres -d cosup_test -X -q -At -v ON_ERROR_STOP=1 "$@" 2>&1 | tr -d '\r'; }
ms() { date +%s%3N; }
FAIL=0; ok() { echo "  ok   $1"; }; bad() { echo "  FAIL $1"; FAIL=1; }

FP="select md5(string_agg(x, '|' order by x)) from (
  select p.proname || ':' || md5(p.prosrc) || ':' || coalesce(array_to_string(p.proacl, ','), '') as x from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and (p.proname like '%co_support%' or p.proname in ('agent_list_empty_house_opportunities','house_has_live_claim',
          'approve_pending_portfolio','reject_pending_portfolio','_psh_no_mixed_support'))
  union all select 'idx:' || pg_get_indexdef(indexrelid) from pg_index where indrelid in ('public.partner_supported_houses'::regclass, 'public.co_support_invites'::regclass)
  union all select 'col:' || attrelid::regclass || '.' || attname || ':' || attnotnull from pg_attribute
   where attrelid in ('public.partner_supported_houses'::regclass, 'public.co_support_invites'::regclass) and attnum > 0 and not attisdropped
  union all select 'con:' || conname from pg_constraint where conrelid = 'public.co_support_invites'::regclass
  union all select 'trg:' || tgname from pg_trigger where tgrelid = 'public.partner_supported_houses'::regclass and not tgisinternal) s"

base() { bash "$S/reset.sh" >/dev/null; node "$S/build_p4.js" >/dev/null; }   # Phase 1 applied, Phase 4 not

echo "== E1 Lock inventory while Phase 4 runs"
base
printf 'BEGIN;\n\\i %s\nSELECT c.relname || %s || string_agg(DISTINCT l.mode, %s) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.pid = pg_backend_pid() AND c.relnamespace = %s::regnamespace AND c.relkind IN (%s,%s) AND l.mode IN (%s,%s,%s) GROUP BY c.relname ORDER BY 1;\nROLLBACK;\n' \
  "$MIG" "' '" "','" "'public'" "'r'" "'v'" "'AccessExclusiveLock'" "'ShareRowExclusiveLock'" "'ExclusiveLock'" > "$S/e1p4.sql"
q -f "$S/e1p4.sql" | grep -v '^$' | sed 's/^/       /'

echo "== E2 A long write on house_listings: Phase 4 gives up after lock_timeout, nothing changes"
base
BASE_FP=$(q -c "$FP")
( "$PSQL" -h localhost -p 55432 -U postgres -d cosup_test -X -q -c "BEGIN; UPDATE house_listings SET title = title WHERE false; SELECT pg_sleep(12); COMMIT;" >/dev/null 2>&1 ) &
sleep 1
T0=$(ms); OUT=$(q -1 -f "$MIG"); T1=$(ms); wait
echo "$OUT" | grep -q "lock timeout" && [ "$(q -c "$FP")" = "$BASE_FP" ] \
  && ok "stopped after $((T1-T0)) ms (lock timeout), database unchanged" || bad "E2: $(echo "$OUT" | tail -2)"

echo "== E3 Timing at volume (20,000 empty houses, 1,000 supported) and the feed before/after"
base
AG=$(q -c "select tt_person from (select gen_random_uuid() as tt_person) x" 2>/dev/null || true)
q -c "insert into profiles (id, full_name) values ('00000000-0000-0000-0000-0000000000cc', 'Feed Partner');
      insert into t_partners (user_id) values ('00000000-0000-0000-0000-0000000000cc');
      insert into house_listings (agent_id, title, district, monthly_rent)
      select gen_random_uuid(), 'House ' || g, 'D' || (g % 40), 100000 + (g % 30) * 10000 from generate_series(1, 20000) g;
      insert into partner_supported_houses (partner_id, house_id, principal, status)
      select gen_random_uuid(), id, monthly_rent, 'active' from house_listings limit 1000;
      analyze;" >/dev/null
FEED="set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000cc'; explain (analyze, format json) select agent_list_empty_house_opportunities(p_limit := 30);"
B=$(q -c "$FEED" | grep -o '"Execution Time": [0-9.]*' | grep -o '[0-9.]*$')
BASE_FP=$(q -c "$FP")
T0=$(ms); q -1 -f "$MIG" >/dev/null; T1=$(ms); APPLY=$((T1-T0))
q -c "insert into co_support_invites (code, house_id, lead_partner_id, rent_amount, gross_amount, lead_rent, invitee_rent, lead_share, invitee_share, expires_at)
      select upper(substr(md5(id::text),1,12)), id, gen_random_uuid(), 300000, 306000, 150000, 150000, 153000, 153000, now() + interval '48 hours'
        from house_listings offset 5000 limit 300; analyze;" >/dev/null
A=$(q -c "$FEED" | grep -o '"Execution Time": [0-9.]*' | grep -o '[0-9.]*$')
TOTAL=$(q -c "set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000cc'; select (agent_list_empty_house_opportunities(p_limit := 1))->>'total'")
q -c "delete from co_support_invites" >/dev/null
T0=$(ms); RBOUT=$(q -1 -f "$RB"); T1=$(ms)
echo "       apply ${APPLY} ms; rollback $((T1-T0)) ms; feed ${B} ms before, ${A} ms after with 300 open house invites (total listed $TOTAL of 19,000 free)"
[ "$(q -c "$FP")" = "$BASE_FP" ] && ok "rollback restored the exact post-Phase-1 state (functions, grants, indexes, columns, constraints, triggers)" \
  || bad "E3 rollback fingerprint differs: $RBOUT"

echo "== E4 Re-apply after rollback, double apply"
q -1 -f "$MIG" >/dev/null && q -1 -f "$MIG" >/dev/null && ok "applies again; a second apply on top is harmless" || bad "E4"

echo "== E5 Rollback refuses while a shared house exists"
bash "$S/reset_p4.sh" >/dev/null
cd "$S" && "$PSQL" -h localhost -p 55432 -U postgres -d cosup_test -X -q -f harness.sql >/dev/null 2>&1
q -c "do \$\$ declare a uuid := tt_person(15,200000); h uuid; begin insert into house_listings (agent_id, title, monthly_rent) values (gen_random_uuid(),'H',300000) returning id into h; perform tt_as(a); perform co_support_create_house(h); end \$\$" >/dev/null
OUT=$(q -1 -f "$RB")
echo "$OUT" | grep -q ROLLBACK_REFUSED && ok "refused; data untouched" || bad "E5: $OUT"

echo "== E6 Real roles"
OUT=$(q -c "set role anon; select co_support_create_house(gen_random_uuid());")
echo "$OUT" | grep -q "permission denied" && ok "anon cannot share a house" || bad "E6 anon: $OUT"
OUT=$(q -c "set role authenticated; select _co_support_open_house_half(gen_random_uuid(), gen_random_uuid(), 1, 1, 'x');")
echo "$OUT" | grep -q "permission denied" && ok "signed-in cannot call the house helpers" || bad "E6 helper: $OUT"

[ $FAIL = 0 ] && echo "ALL PHASE 4 SRE CHECKS PASSED" || echo "PHASE 4 SRE CHECKS FAILED"
