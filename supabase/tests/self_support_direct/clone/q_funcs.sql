select p.prokind k, pg_get_functiondef(p.oid) d from pg_proc p
where p.pronamespace='public'::regnamespace and p.prokind in ('f','p')
  and not exists (select 1 from pg_depend dp where dp.objid=p.oid and dp.deptype='e')
