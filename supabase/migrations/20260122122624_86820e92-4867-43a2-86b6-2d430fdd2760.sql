-- Create a function to notify supporters of new rent opportunities via push notification
CREATE OR REPLACE FUNCTION public.notify_supporters_new_opportunity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  tenant_name TEXT;
  supporter_ids UUID[];
BEGIN
  -- Get tenant name
  SELECT full_name INTO tenant_name FROM public.profiles WHERE id = NEW.tenant_id;
  
  -- Get all supporter user IDs
  SELECT ARRAY_AGG(user_id) INTO supporter_ids
  FROM public.user_roles
  WHERE role = 'supporter' AND enabled = true;
  
  -- If we have supporters to notify
  IF supporter_ids IS NOT NULL AND array_length(supporter_ids, 1) > 0 THEN
    -- Create in-app notifications for all supporters
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    SELECT 
      unnest(supporter_ids),
      '💰 New Investment Opportunity!',
      COALESCE(tenant_name, 'A tenant') || ' needs UGX ' || NEW.rent_amount::text || ' for rent. Fund now to earn returns!',
      'opportunity',
      jsonb_build_object(
        'rent_request_id', NEW.id,
        'rent_amount', NEW.rent_amount,
        'tenant_name', tenant_name,
        'action', 'view_opportunity',
        'send_push', true
      );
    
    -- Call edge function to send push notifications via pg_net
    PERFORM net.http_post(
      url := current_setting('app.settings.supabase_url', true) || '/functions/v1/send-push-notification',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
      ),
      body := jsonb_build_object(
        'userIds', supporter_ids,
        'payload', jsonb_build_object(
          'title', '💰 New Investment Opportunity!',
          'body', COALESCE(tenant_name, 'A tenant') || ' needs UGX ' || NEW.rent_amount::text || ' for rent. Fund now!',
          'url', '/opportunities',
          'type', 'opportunity'
        )
      )
    );
  END IF;
  
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Log error but don't fail the transaction
    RAISE WARNING 'notify_supporters_new_opportunity error: %', SQLERRM;
    RETURN NEW;
END;
$function$;

-- Create trigger to notify supporters when a new rent request is created
DROP TRIGGER IF EXISTS on_new_rent_request_notify_supporters ON public.rent_requests;
CREATE TRIGGER on_new_rent_request_notify_supporters
  AFTER INSERT ON public.rent_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_supporters_new_opportunity();