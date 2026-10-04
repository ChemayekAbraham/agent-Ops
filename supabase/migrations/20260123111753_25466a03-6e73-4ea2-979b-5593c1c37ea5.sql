-- Create function to notify supporters when their investment request status changes
CREATE OR REPLACE FUNCTION public.notify_investment_request_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  notification_title TEXT;
  notification_message TEXT;
  notification_type TEXT;
BEGIN
  -- Only trigger on status change
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    -- Set message based on new status
    CASE NEW.status
      WHEN 'processing' THEN
        notification_title := '⏳ Investment Request Processing';
        notification_message := 'A manager is now processing your ' || NEW.amount || ' UGX investment request.';
        notification_type := 'info';
      WHEN 'completed' THEN
        notification_title := '🎉 Investment Account Ready!';
        notification_message := 'Your ' || NEW.amount || ' UGX investment is now active! You''ll earn 15% monthly ROI.';
        notification_type := 'success';
      WHEN 'rejected' THEN
        notification_title := '❌ Investment Request Update';
        notification_message := COALESCE(NEW.manager_notes, 'Your investment request could not be processed. Please contact support.');
        notification_type := 'warning';
      ELSE
        notification_title := '📊 Investment Request Update';
        notification_message := 'Your investment request status has been updated to: ' || NEW.status;
        notification_type := 'info';
    END CASE;
    
    -- Create in-app notification
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      NEW.supporter_id,
      notification_title,
      notification_message,
      notification_type,
      jsonb_build_object(
        'request_id', NEW.id,
        'amount', NEW.amount,
        'status', NEW.status,
        'investment_account_id', NEW.investment_account_id,
        'send_push', true
      )
    );
    
    -- Call edge function to send push notification via pg_net
    PERFORM net.http_post(
      url := current_setting('app.settings.supabase_url', true) || '/functions/v1/send-push-notification',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
      ),
      body := jsonb_build_object(
        'userIds', ARRAY[NEW.supporter_id::text],
        'payload', jsonb_build_object(
          'title', notification_title,
          'body', notification_message,
          'url', CASE 
            WHEN NEW.status = 'completed' THEN '/investment-portfolio'
            ELSE '/dashboard'
          END,
          'type', 'investment_request'
        )
      )
    );
  END IF;
  
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Log error but don't fail the update
    RAISE WARNING 'notify_investment_request_status_change error: %', SQLERRM;
    RETURN NEW;
END;
$$;

-- Create trigger on manager_investment_requests table
DROP TRIGGER IF EXISTS on_investment_request_status_change ON public.manager_investment_requests;
CREATE TRIGGER on_investment_request_status_change
  AFTER UPDATE ON public.manager_investment_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_investment_request_status_change();