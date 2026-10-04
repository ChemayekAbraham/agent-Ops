BEGIN;

SET LOCAL lock_timeout = '5s';

-- Wrapper: reads the service credential from the vault so the schedule itself
-- carries no secret. Posts to the acknowledgement function; that function
-- accepts only a service-role bearer or an hr/super_admin caller.
CREATE OR REPLACE FUNCTION public.invoke_hr_careers_acknowledge()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_url text := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/hr-careers-acknowledge';
  v_service_key text;
BEGIN
  SELECT decrypted_secret INTO v_service_key
  FROM vault.decrypted_secrets
  WHERE name = 'email_queue_service_role_key'
  LIMIT 1;

  IF v_service_key IS NULL THEN
    RAISE WARNING 'invoke_hr_careers_acknowledge: service credential not available; skipping run';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body := jsonb_build_object('source', 'pg_cron', 'at', now())
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.invoke_hr_careers_acknowledge() FROM PUBLIC;

SELECT cron.unschedule('hr-careers-acknowledge-15min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'hr-careers-acknowledge-15min');

SELECT cron.schedule(
  'hr-careers-acknowledge-15min',
  '*/15 * * * *',
  $cron$SELECT public.invoke_hr_careers_acknowledge();$cron$
);

COMMIT;