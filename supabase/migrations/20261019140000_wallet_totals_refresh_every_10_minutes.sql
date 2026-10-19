-- 2026-10-19 (doc 247, step 27): refresh-wallet-totals-cache every 10 minutes instead of every 3 (Josh's decision).
-- The refresh takes 20-120 s and was saturating the database during the workday (36-45 s at 06:00-08:00 UTC, 80-120 s at 09:00 UTC on 19 Oct),
-- which pushed other queries into the 8 s API timeout. Trade-off: the cached wallet totals shown on dashboards can be up to 10 minutes old (was 3).
-- Applied to production 2026-10-19. Revert: select cron.alter_job(<jobid>, schedule := '*/3 * * * *');
do $$
declare v_id bigint;
begin
  select jobid into v_id from cron.job where jobname = 'refresh-wallet-totals-cache';
  if v_id is not null then perform cron.alter_job(v_id, schedule := '*/10 * * * *'); end if;
end $$;
