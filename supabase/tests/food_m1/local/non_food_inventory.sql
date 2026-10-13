-- Fingerprint of everything that is NOT a Food object: functions, tables,
-- columns, constraints, indexes, policies, triggers, views, table/function/
-- schema ACLs, default privileges and role memberships. Applying the Food
-- migrations must leave every line identical.
select x from (
  select 'fn '||n.nspname||'.'||p.oid::regprocedure||' '||md5(replace(pg_get_functiondef(p.oid), chr(13), ''))
         ||' sd='||p.prosecdef||' cfg='||coalesce(array_to_string(p.proconfig,','),'')
         ||' acl='||coalesce(array_to_string(p.proacl,','),'') x
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname in ('public','auth','canary','storage') and p.prokind in ('f','p')
     and p.proname not like 'food%' and p.proname not like 'is\_%food%'
  union all select 'rel '||n.nspname||'.'||c.relname||' kind='||c.relkind::text||' rls='||c.relrowsecurity
         ||' force='||c.relforcerowsecurity||' acl='||coalesce(array_to_string(c.relacl,','),'')
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname in ('public','auth','canary','storage') and c.relname not like 'food%' and c.relkind in ('r','v','m','S','p')
  union all select 'col '||table_schema||'.'||table_name||'.'||column_name||' '||data_type||' '||is_nullable||' '||coalesce(column_default,'')
    from information_schema.columns where table_schema in ('public','auth','canary','storage') and table_name not like 'food%'
  union all select 'con '||conrelid::regclass||' '||conname||' '||pg_get_constraintdef(oid)
    from pg_constraint where conrelid <> 0 and conrelid::regclass::text not like '%food%'
     and connamespace in (select oid from pg_namespace where nspname in ('public','auth','canary','storage'))
  union all select 'idx '||schemaname||' '||indexdef from pg_indexes
   where schemaname in ('public','auth','canary','storage') and tablename not like 'food%'
  union all select 'pol '||schemaname||'.'||tablename||' '||policyname||' '||cmd||' '||array_to_string(roles,',')||' '||coalesce(qual,'')||' '||coalesce(with_check,'')
    from pg_policies where tablename not like 'food%' and policyname not like 'food\_%'
  union all select 'trg '||tgrelid::regclass||' '||tgname||' '||pg_get_triggerdef(oid)
    from pg_trigger where not tgisinternal and tgrelid::regclass::text not like '%food%'
  union all select 'view '||schemaname||'.'||viewname||' '||md5(definition) from pg_views
   where schemaname in ('public','auth','canary','storage')
  union all select 'nsp '||nspname||' acl='||coalesce(array_to_string(nspacl,','),'')
    from pg_namespace where nspname in ('public','auth','canary','storage')
  union all select 'defacl '||defaclrole::regrole||' '||defaclobjtype::text||' '||coalesce(defaclnamespace::regnamespace::text,'-')||' '||array_to_string(defaclacl,',')
    from pg_default_acl
  union all select 'member '||m.roleid::regrole||' > '||m.member::regrole from pg_auth_members m
   where m.roleid::regrole::text in ('anon','authenticated','service_role','authenticator')
  union all select 'role '||rolname||' super='||rolsuper||' bypassrls='||rolbypassrls||' login='||rolcanlogin
    from pg_roles where rolname in ('anon','authenticated','service_role','authenticator')
) s order by x;
