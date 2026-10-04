DO $$
BEGIN
  PERFORM cron.unschedule(6410);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'unschedule 6410 failed: %', SQLERRM;
END $$;

SELECT cron.alter_job(6971, schedule => '30 15 * * *');