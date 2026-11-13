select n.nspname s, p.proname n, pg_get_function_identity_arguments(p.oid) a, pg_get_function_result(p.oid) r
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname in ('auth','net','pgmq','vault','cron','storage','extensions') order by 1,2
