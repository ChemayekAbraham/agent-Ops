-- 2026-10-25: (1) Supabase performance lint (auth_rls_initplan) on welile_schools policy ws_insert, and the same pattern in ws_update and in the Welile Medicine tables
-- (welile_medical_facilities / profiles / gate_logs / transactions, created by Lovable on 2026-10-24/25): auth.uid() is wrapped as (select auth.uid()) so Postgres evaluates it once per query.
-- Same access rules; only the evaluation changes. (2) Grants on these tables: anon none (the policies are authenticated-only, the grant was unused); authenticated keeps INSERT, SELECT, UPDATE
-- (no DELETE, TRUNCATE, REFERENCES, TRIGGER: there is no delete policy, and TRUNCATE would ignore RLS).
-- Tested in a rolled-back transaction: an agent adds a facility and a receipt and sees them; spoofing another agent's id is refused; delete is refused; another agent sees the facility
-- (directory, by design) but not the receipt; anon is denied. Applied to production 2026-10-25. Re-run safe.
do $do$
declare r record; q text; w text; stmt text;
begin
  set local lock_timeout = '5s';
  for r in select p.polname, p.polrelid::regclass::text tbl, pg_get_expr(p.polqual, p.polrelid) qual, pg_get_expr(p.polwithcheck, p.polrelid) wcheck
           from pg_policy p join pg_class c on c.oid = p.polrelid
           where c.relnamespace = 'public'::regnamespace and (c.relname like 'welile\_school%' or c.relname like 'welile\_medical%')
             and ((pg_get_expr(p.polqual, p.polrelid) ~ '(?<!SELECT )auth\.uid\(\)') or (pg_get_expr(p.polwithcheck, p.polrelid) ~ '(?<!SELECT )auth\.uid\(\)')) loop
    q := regexp_replace(r.qual, '(?<!SELECT )auth\.uid\(\)', '(select auth.uid())', 'g');
    w := regexp_replace(r.wcheck, '(?<!SELECT )auth\.uid\(\)', '(select auth.uid())', 'g');
    stmt := format('alter policy %I on %s', r.polname, r.tbl);
    if r.qual is not null then stmt := stmt || ' using (' || q || ')'; end if;
    if r.wcheck is not null then stmt := stmt || ' with check (' || w || ')'; end if;
    execute stmt;
  end loop;
  for r in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and (c.relname like 'welile\_school%' or c.relname like 'welile\_medical%') loop
    execute format('revoke all on table public.%I from anon', r.relname);
    execute format('revoke delete, truncate, references, trigger on table public.%I from authenticated', r.relname);
  end loop;
end $do$;
