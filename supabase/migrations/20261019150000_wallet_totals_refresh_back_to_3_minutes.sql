-- 2026-10-19 (doc 247, step 28): revert step 27. Josh's rule: never cache finances / never make a finance cache staler.
-- refresh-wallet-totals-cache goes back to every 3 minutes. Applied to production 2026-10-19.
do $$
declare v_id bigint;
begin
  select jobid into v_id from cron.job where jobname = 'refresh-wallet-totals-cache';
  if v_id is not null then perform cron.alter_job(v_id, schedule := '*/3 * * * *'); end if;
end $$;
