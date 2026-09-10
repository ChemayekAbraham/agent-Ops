CREATE OR REPLACE FUNCTION public.invoke_engrep_harvest_commits()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_url text := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/engrep-harvest-commits';
  v_service_key text;
BEGIN
  SELECT decrypted_secret INTO v_service_key
  FROM vault.decrypted_secrets
  WHERE name = 'email_queue_service_role_key'
  LIMIT 1;

  IF v_service_key IS NULL THEN
    RAISE WARNING 'invoke_engrep_harvest_commits: service credential not available; skipping run';
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
$function$;

REVOKE ALL ON FUNCTION public.invoke_engrep_harvest_commits() FROM public;
REVOKE ALL ON FUNCTION public.invoke_engrep_harvest_commits() FROM anon;
REVOKE ALL ON FUNCTION public.invoke_engrep_harvest_commits() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_engrep_harvest_commits() TO service_role;

SELECT cron.unschedule('engrep-harvest-commits-1705-eat');
SELECT cron.schedule('engrep-harvest-commits-1705-eat', '5 14 * * *', $$SELECT public.invoke_engrep_harvest_commits();$$);