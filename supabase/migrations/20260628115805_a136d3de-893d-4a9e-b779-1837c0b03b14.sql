CREATE OR REPLACE FUNCTION public.notify_merchants_new_withdrawal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_supabase_url text := 'https://wirntoujqoyjobfhyelc.supabase.co';
  v_service_key  text;
BEGIN
  IF NEW.status IN ('pending', 'requested') THEN
    BEGIN
      SELECT decrypted_secret INTO v_service_key
      FROM vault.decrypted_secrets
      WHERE name = 'service_role_key'
      LIMIT 1;

      IF v_service_key IS NOT NULL THEN
        PERFORM net.http_post(
          url := v_supabase_url || '/functions/v1/notify-merchants-new-withdrawal',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || v_service_key
          ),
          body := jsonb_build_object('withdrawal_id', NEW.id::text)
        );
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE WARNING '[notify_merchants_new_withdrawal] dispatch failed: %', SQLERRM;
    END;
  END IF;

  RETURN NEW;
END;
$function$;