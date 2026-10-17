-- 2026-10-17 (doc 247): 80 more views/materialized views in public ran with owner rights (no security_invoker)
-- and were readable by the public role `anon`: whole general ledger (~714k rows), all wallet balances (97k),
-- tenant/landlord/agent contact directories, receivables/payables history, cron run details.
-- Nothing in src/ reads them signed out; edge functions use the service key. Already applied to production
-- 2026-10-17; this file keeps rebuilds consistent. Idempotent. Views with security_invoker=true are left alone
-- (row-level security already applies to them).
-- NOT changed here: `authenticated` still reads them (staff dashboards depend on it); see doc 247.
do $$
declare r record;
begin
  for r in
    select c.oid::regclass as rel
      from pg_class c
     where c.relnamespace = 'public'::regnamespace
       and c.relkind in ('v', 'm')
       and not coalesce(c.reloptions::text ilike '%security_invoker=true%', false)
       and has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate,references,trigger')
  loop
    execute format('revoke all on %s from anon', r.rel);
  end loop;
end $$;
