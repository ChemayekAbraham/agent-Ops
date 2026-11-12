select 'e' k, t.typname n, (select json_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid=t.oid)::text d
  from pg_type t where t.typnamespace='public'::regnamespace and t.typtype='e'
union all
select 'd', t.typname, format_type(t.typbasetype,t.typtypmod) || coalesce(' '||(select string_agg(pg_get_constraintdef(c.oid),' ') from pg_constraint c where c.contypid=t.oid),'')
  from pg_type t where t.typnamespace='public'::regnamespace and t.typtype='d'
union all
select 'c', t.typname, (select string_agg(quote_ident(a.attname)||' '||format_type(a.atttypid,a.atttypmod), ', ' order by a.attnum) from pg_attribute a where a.attrelid=t.typrelid and a.attnum>0 and not a.attisdropped)
  from pg_type t join pg_class c on c.oid=t.typrelid where t.typnamespace='public'::regnamespace and t.typtype='c' and c.relkind='c'
union all
select 's', c.relname, format('CREATE SEQUENCE IF NOT EXISTS public.%I', c.relname) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='S'
