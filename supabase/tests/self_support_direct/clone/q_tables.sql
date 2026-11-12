select c.relname as t, c.relkind as k, c.relrowsecurity as rls,
  (select json_agg(json_build_object('n',a.attname,'ty',format_type(a.atttypid,a.atttypmod),'nn',a.attnotnull,
     'd',pg_get_expr(ad.adbin,ad.adrelid),'id',a.attidentity,'g',a.attgenerated) order by a.attnum)
   from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum
   where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) as cols,
  (select json_agg(json_build_object('n',co.conname,'ty',co.contype,'d',pg_get_constraintdef(co.oid)) order by co.contype desc, co.conname)
   from pg_constraint co where co.conrelid=c.oid and co.contype in ('p','u','c','x')) as cons,
  (select json_agg(pg_get_indexdef(i.indexrelid)) from pg_index i where i.indrelid=c.oid
     and not exists (select 1 from pg_constraint co where co.conindid=i.indexrelid)) as idx
from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','p') and not c.relispartition
order by c.relname
