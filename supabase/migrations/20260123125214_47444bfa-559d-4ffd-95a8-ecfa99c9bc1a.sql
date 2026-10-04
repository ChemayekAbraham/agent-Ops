-- Create function to notify users of withdrawal status changes
CREATE OR REPLACE FUNCTION public.notify_withdrawal_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  notification_title TEXT;
  notification_message TEXT;
  notification_type TEXT;
  user_name TEXT;
BEGIN
  -- Only trigger on status change from pending
  IF OLD.status = 'pending' AND OLD.status IS DISTINCT FROM NEW.status THEN
    -- Get user name for the message
    SELECT full_name INTO user_name FROM public.profiles WHERE id = NEW.user_id;
    
    -- Set message based on new status
    CASE NEW.status
      WHEN 'approved' THEN
        notification_title := '✅ Withdrawal Approved!';
        notification_message := 'Your withdrawal of UGX ' || NEW.amount::text || ' has been approved and sent to ' || 
          COALESCE(UPPER(NEW.mobile_money_provider), 'Mobile Money') || ' ' || COALESCE(NEW.mobile_money_number, 'your number') || '.';
        notification_type := 'success';
      WHEN 'rejected' THEN
        notification_title := '❌ Withdrawal Rejected';
        notification_message := COALESCE(NEW.rejection_reason, 'Your withdrawal request could not be processed. Please contact support.');
        notification_type := 'warning';
      ELSE
        RETURN NEW;
    END CASE;
    
    -- Create in-app notification
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      NEW.user_id,
      notification_title,
      notification_message,
      notification_type,
      jsonb_build_object(
        'withdrawal_id', NEW.id,
        'amount', NEW.amount,
        'status', NEW.status,
        'mobile_money_number', NEW.mobile_money_number,
        'mobile_money_provider', NEW.mobile_money_provider,
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
        'userIds', ARRAY[NEW.user_id::text],
        'payload', jsonb_build_object(
          'title', notification_title,
          'body', notification_message,
          'url', '/dashboard',
          'type', 'withdrawal'
        )
      )
    );
  END IF;
  
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Log error but don't fail the update
    RAISE WARNING 'notify_withdrawal_status_change error: %', SQLERRM;
    RETURN NEW;
END;
$$;

-- Create trigger for withdrawal status changes
DROP TRIGGER IF EXISTS on_withdrawal_status_change ON public.withdrawal_requests;
CREATE TRIGGER on_withdrawal_status_change
  AFTER UPDATE ON public.withdrawal_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_withdrawal_status_change();