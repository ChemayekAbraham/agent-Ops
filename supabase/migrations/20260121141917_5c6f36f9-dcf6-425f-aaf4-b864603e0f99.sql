-- Update the trigger function to also call the notify-watchers edge function
CREATE OR REPLACE FUNCTION public.notify_watchers_on_verification()
RETURNS TRIGGER AS $$
DECLARE
  tenant_name TEXT;
BEGIN
  -- Check if the request just became fully verified (both agent and manager)
  IF (NEW.agent_verified = true AND NEW.manager_verified = true) AND 
     (OLD.agent_verified IS DISTINCT FROM true OR OLD.manager_verified IS DISTINCT FROM true) THEN
    
    -- Get tenant name
    SELECT full_name INTO tenant_name FROM public.profiles WHERE id = NEW.tenant_id;
    
    -- Create in-app notifications for all watchers
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    SELECT 
      wo.user_id,
      '✅ Opportunity Ready!',
      'A rent request you''re watching is now fully verified and ready to fund. Rent amount: UGX ' || NEW.rent_amount::text,
      'success',
      jsonb_build_object(
        'rent_request_id', NEW.id,
        'rent_amount', NEW.rent_amount,
        'tenant_name', tenant_name,
        'action', 'view_opportunity',
        'send_push', true
      )
    FROM public.watched_opportunities wo
    WHERE wo.rent_request_id = NEW.id
      AND wo.notified_at IS NULL;
    
    -- Mark watchers as notified
    UPDATE public.watched_opportunities
    SET notified_at = now()
    WHERE rent_request_id = NEW.id
      AND notified_at IS NULL;
      
    -- Call the notify-watchers edge function via pg_net if available
    -- This will send push notifications to all watchers
    PERFORM net.http_post(
      url := current_setting('app.settings.supabase_url', true) || '/functions/v1/notify-watchers',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
      ),
      body := jsonb_build_object(
        'rent_request_id', NEW.id,
        'rent_amount', NEW.rent_amount,
        'tenant_name', tenant_name
      )
    );
  END IF;
  
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Log error but don't fail the transaction
    RAISE WARNING 'notify_watchers_on_verification error: %', SQLERRM;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;