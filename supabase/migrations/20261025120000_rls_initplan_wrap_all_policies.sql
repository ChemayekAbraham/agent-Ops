-- 2026-10-25: Supabase performance lint auth_rls_initplan, fixed for the WHOLE database in one mechanical rewrite (it had been reported one policy at a time:
-- hr_pay_prompts_read, ws_insert, tenant_inactive_reviews, credit_access_draws "Staff insert draws", agent_ops_reports agent_ops_insert_reports,
-- agent_registration_gate_overrides, deposit_bridge_gap_alerts "Staff can resolve gap alerts", and more).
--
-- Problem: 1,507 of 2,902 policies on 754 tables called auth.uid() / auth.role() / auth.jwt(), or helper functions such as has_role(auth.uid(), 'cfo'), directly in the policy.
-- Postgres then re-ran them for EVERY candidate row. has_role alone appeared 3,051 times in policy text.
-- Fix: wrap each in a scalar select so Postgres evaluates it once per query (an initPlan):
--     auth.uid()                         ->  (select auth.uid())
--     has_role(auth.uid(), 'cfo')        ->  (select has_role((select auth.uid()), 'cfo'))
-- The inner (select auth.uid()) is kept so Supabase's lint, which looks for that literal text, clears. A helper call is wrapped only when ALL its arguments are
-- auth.uid() or literal constants and the function is STABLE or IMMUTABLE (never VOLATILE), i.e. its result cannot depend on the row.
-- Access rules are unchanged; only evaluation changes.
--
-- Verified 2026-10-25 before and after on a sample of 65 tables as four user types (manager, cfo, agent-only, tenant-only), 260 row counts: 258 identical; the other 2
-- (ledger_reconciled_tids 11,611 -> 11,612 for manager and cfo) were a live insert, confirmed by the owner count (11,612). Speed, audit_logs read as a manager:
-- 2-day slice 50-100 ms -> 2 ms; the full 495,987-row table 114 ms (repeated full reads timed out before). App 5xx and 403 counts stayed at 0 during the rollout.
-- Applied to production 2026-10-25 in batches of 200 to 450 policies, 0 failures. Safe to re-run (policies already wrapped are skipped).
-- Rule for new policies (CLAUDE.md): write (select auth.uid()) and wrap row-independent helper calls in a select.

create schema if not exists _fn_lockdown;

create or replace function _fn_lockdown.wrap_policy_expr(e text) returns text language plpgsql stable as $$
declare r text := e; fn text; lit text := '(?:, ?(?:''[^'']*''(?:::[a-z_ ]+)?|-?[0-9]+(?:\.[0-9]+)?|true|false))*';
begin
  if r is null then return null; end if;
  for fn in select distinct m[1] from regexp_matches(r, '(?<!select )(?<![\w.])([a-z_][a-z0-9_]*)\(auth\.uid\(\)' || lit || '\)', 'gi') as m loop
    if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = fn)
       and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = fn and p.provolatile = 'v') then
      r := regexp_replace(r, '(?<!select )(?<![\w.])' || fn || '\(auth\.uid\(\)(' || lit || ')\)', '@@S@@' || fn || '(@@UID@@\1)@@E@@', 'gi');
    end if;
  end loop;
  r := regexp_replace(r, '(?<!select )auth\.(uid|role|jwt)\(\)', '(select auth.\1())', 'gi');
  r := replace(replace(replace(r, '@@S@@', '(select '), '@@E@@', ')'), '@@UID@@', '(select auth.uid())');
  return r;
end $$;

create table if not exists _fn_lockdown.policy_rewrite_log (tbl text, polname text, ok boolean, err text, at timestamptz default now());

do $do$
declare r record; nq text; nw text; stmt text; done int := 0; failed int := 0;
begin
  set local lock_timeout = '3s';
  for r in
    select p.polrelid::regclass::text tbl, p.polname, pg_get_expr(p.polqual, p.polrelid) q, pg_get_expr(p.polwithcheck, p.polrelid) w
    from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relnamespace = 'public'::regnamespace
      and (_fn_lockdown.wrap_policy_expr(pg_get_expr(p.polqual, p.polrelid)) is distinct from pg_get_expr(p.polqual, p.polrelid)
        or _fn_lockdown.wrap_policy_expr(pg_get_expr(p.polwithcheck, p.polrelid)) is distinct from pg_get_expr(p.polwithcheck, p.polrelid))
    order by 1, 2
  loop
    nq := _fn_lockdown.wrap_policy_expr(r.q); nw := _fn_lockdown.wrap_policy_expr(r.w);
    stmt := format('alter policy %I on %s', r.polname, r.tbl);
    if r.q is not null then stmt := stmt || ' using (' || nq || ')'; end if;
    if r.w is not null then stmt := stmt || ' with check (' || nw || ')'; end if;
    begin
      execute stmt; done := done + 1;
      insert into _fn_lockdown.policy_rewrite_log values (r.tbl, r.polname, true, null);
    exception when others then
      failed := failed + 1;
      insert into _fn_lockdown.policy_rewrite_log values (r.tbl, r.polname, false, left(sqlerrm, 80));
    end;
  end loop;
  raise notice 'policies rewritten: %, failed: %', done, failed;
end $do$;
