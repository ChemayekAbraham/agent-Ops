-- 2026-10-20 (doc 247, step 32): the database move re-created Supabase's default wide table grants. anon held INSERT/UPDATE/DELETE/TRUNCATE on all 866 public tables;
-- only row-level security (on for every table) stopped writes. Revoke anon's write privileges everywhere, keep INSERT only for tables with a policy that names anon
-- (public forms and logs) plus four known pre-login writers, and stop new tables inheriting the wide grants. authenticated is unchanged (the app relies on RLS there).
-- Applied to production 2026-10-20. Undo for one table: grant insert on public.<t> to anon;
do $do$
declare r record; keep text[]; d record;
begin
  select array_agg(distinct tablename) into keep from (
    select tablename from pg_policies where schemaname='public' and permissive='PERMISSIVE' and cmd in ('INSERT','ALL') and roles::text like '%anon%' and coalesce(with_check,'') <> 'false' and coalesce(qual,'') <> 'false'
    union select unnest(array['career_link_clicks','business_advance_share_events','house_share_events','landlord_leads'])
  ) t;
  for r in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') loop
    execute format('revoke update, delete, truncate, references, trigger on table public.%I from anon', r.relname);
    if not (r.relname = any(keep)) then execute format('revoke insert on table public.%I from anon', r.relname); end if;
  end loop;
  for r in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('v','m','f') loop
    execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from anon', r.relname);
  end loop;
  for d in select pg_get_userbyid(defaclrole) as owner from pg_default_acl where defaclnamespace='public'::regnamespace and defaclobjtype='r' loop
    execute format('alter default privileges for role %I in schema public revoke insert, update, delete, truncate, references, trigger on tables from anon', d.owner);
  end loop;
end $do$;
