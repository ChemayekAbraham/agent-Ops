CREATE OR REPLACE FUNCTION public.funder_release_sms_dispatch()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.funder_release_sms
     WHERE status = 'pending' AND attempts < 4
  ) THEN
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets
   WHERE name = 'email_queue_service_role_key'
   LIMIT 1;

  IF v_key IS NULL OR btrim(v_key) = '' THEN
    RAISE WARNING 'funder release sms dispatch skipped: email_queue_service_role_key is not in vault';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://byrzshwlentqvktcksem.supabase.co/functions/v1/notify-funder-release-sms',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := '{}'::jsonb
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'funder release sms dispatch failed: %', SQLERRM;
END;
$function$
