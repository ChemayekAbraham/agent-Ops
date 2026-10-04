CREATE OR REPLACE FUNCTION public.notify_merchants_new_withdrawal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Fire a fire-and-forget alert email to active merchant (cash-out) agents
  -- whenever a brand-new pending withdrawal request is created.
  IF NEW.status IN ('pending', 'requested') THEN
    BEGIN
      PERFORM net.http_post(
        url := current_setting('app.settings.supabase_url', true) || '/functions/v1/notify-merchants-new-withdrawal',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
        ),
        body := jsonb_build_object('withdrawal_id', NEW.id::text)
      );
    EXCEPTION
      WHEN OTHERS THEN
        RAISE WARNING 'Merchant withdrawal alert failed: %', SQLERRM;
    END;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_notify_merchants_new_withdrawal ON public.withdrawal_requests;
CREATE TRIGGER trg_notify_merchants_new_withdrawal
AFTER INSERT ON public.withdrawal_requests
FOR EACH ROW
EXECUTE FUNCTION public.notify_merchants_new_withdrawal();