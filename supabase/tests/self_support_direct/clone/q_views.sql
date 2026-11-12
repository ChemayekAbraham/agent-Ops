select c.relname n, c.relkind k, pg_get_viewdef(c.oid) d,
  (select array_to_string(c.reloptions, ',')) opts
from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('v','m')
  and not exists (select 1 from pg_depend dp where dp.objid=c.oid and dp.deptype='e')
