-- Create function to send push notification on new chat message
CREATE OR REPLACE FUNCTION public.notify_new_chat_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  sender_name TEXT;
  recipient_id UUID;
  message_preview TEXT;
  conversation_record RECORD;
BEGIN
  -- Get sender name
  SELECT full_name INTO sender_name FROM public.profiles WHERE id = NEW.sender_id;
  
  -- Get all participants in this conversation except the sender
  FOR conversation_record IN 
    SELECT cp.user_id
    FROM public.conversation_participants cp
    WHERE cp.conversation_id = NEW.conversation_id
      AND cp.user_id != NEW.sender_id
  LOOP
    recipient_id := conversation_record.user_id;
    
    -- Truncate message for preview
    message_preview := CASE 
      WHEN LENGTH(NEW.content) > 50 THEN LEFT(NEW.content, 47) || '...'
      ELSE NEW.content
    END;
    
    -- Create in-app notification
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      recipient_id,
      '💬 ' || COALESCE(sender_name, 'Someone') || ' sent a message',
      message_preview,
      'chat',
      jsonb_build_object(
        'conversation_id', NEW.conversation_id,
        'message_id', NEW.id,
        'sender_id', NEW.sender_id,
        'sender_name', sender_name,
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
        'userIds', ARRAY[recipient_id::text],
        'payload', jsonb_build_object(
          'title', '💬 ' || COALESCE(sender_name, 'Someone'),
          'body', message_preview,
          'url', '/chat?conversation=' || NEW.conversation_id::text,
          'type', 'chat'
        )
      )
    );
  END LOOP;
  
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Log error but don't fail the message insert
    RAISE WARNING 'notify_new_chat_message error: %', SQLERRM;
    RETURN NEW;
END;
$$;

-- Create trigger on messages table
DROP TRIGGER IF EXISTS on_new_chat_message ON public.messages;
CREATE TRIGGER on_new_chat_message
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_new_chat_message();