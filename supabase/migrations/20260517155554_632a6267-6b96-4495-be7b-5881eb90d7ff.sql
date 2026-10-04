CREATE OR REPLACE FUNCTION public.notify_tenant_on_business_advance_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url text;
  v_key text;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    BEGIN
      v_url := current_setting('app.settings.supabase_url', true);
      v_key := current_setting('app.settings.service_role_key', true);
    EXCEPTION WHEN OTHERS THEN
      v_url := NULL; v_key := NULL;
    END;

    IF v_url IS NOT NULL AND v_key IS NOT NULL THEN
      PERFORM net.http_post(
        url := v_url || '/functions/v1/notify-business-advance-status',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_key
        ),
        body := jsonb_build_object(
          'advance_id', NEW.id,
          'new_status', NEW.status::text,
          'old_status', OLD.status::text
        )
      );
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'notify_tenant_on_business_advance_status error: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_business_advance_status_notify_tenant ON public.business_advances;
CREATE TRIGGER on_business_advance_status_notify_tenant
AFTER UPDATE OF status ON public.business_advances
FOR EACH ROW
EXECUTE FUNCTION public.notify_tenant_on_business_advance_status();

-- Also fire on initial INSERT so the tenant gets the "Submitted" confirmation
CREATE OR REPLACE FUNCTION public.notify_tenant_on_business_advance_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url text;
  v_key text;
BEGIN
  BEGIN
    v_url := current_setting('app.settings.supabase_url', true);
    v_key := current_setting('app.settings.service_role_key', true);
  EXCEPTION WHEN OTHERS THEN
    v_url := NULL; v_key := NULL;
  END;

  IF v_url IS NOT NULL AND v_key IS NOT NULL THEN
    PERFORM net.http_post(
      url := v_url || '/functions/v1/notify-business-advance-status',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_key
      ),
      body := jsonb_build_object(
        'advance_id', NEW.id,
        'new_status', NEW.status::text
      )
    );
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'notify_tenant_on_business_advance_insert error: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_business_advance_insert_notify_tenant ON public.business_advances;
CREATE TRIGGER on_business_advance_insert_notify_tenant
AFTER INSERT ON public.business_advances
FOR EACH ROW
EXECUTE FUNCTION public.notify_tenant_on_business_advance_insert();