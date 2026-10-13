-- Schema inventory of everything Food owns, one sorted line per object.
-- Used by migration_matrix.sh to prove two install paths produce the same schema.
-- Function bodies are compared with carriage returns removed: a migration file
-- checked out on Windows (CRLF) and the same file from git (LF) define the
-- same function.
select x from (
  select 'fn '||p.oid::regprocedure||' '||md5(replace(pg_get_functiondef(p.oid), chr(13), ''))||' '||coalesce(array_to_string(p.proacl,','),'') x
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and (p.proname like 'food%' or p.proname like 'is_%food%')
  union all select 'col '||table_name||'.'||column_name||' '||data_type||' '||is_nullable||' '||coalesce(column_default,'')
    from information_schema.columns where table_schema='public' and table_name like 'food%'
  union all select 'con '||conrelid::regclass||' '||conname||' '||pg_get_constraintdef(oid)||' '||convalidated
    from pg_constraint where conrelid::regclass::text like 'food%'
  union all select 'idx '||indexdef from pg_indexes where schemaname='public' and tablename like 'food%'
  union all select 'pol '||tablename||' '||policyname||' '||cmd||' '||coalesce(qual,'')||' '||coalesce(with_check,'')
    from pg_policies where schemaname='public' and tablename like 'food%'
  union all select 'trg '||tgrelid::regclass||' '||tgname from pg_trigger where not tgisinternal and tgrelid::regclass::text like 'food%'
  union all select 'acl '||c.relname||' '||coalesce(array_to_string(c.relacl,','),'')||' rls='||c.relrowsecurity
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname like 'food%' and c.relkind='r'
) s order by x;
