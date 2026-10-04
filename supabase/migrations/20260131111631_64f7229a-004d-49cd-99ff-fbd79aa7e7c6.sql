-- Create a table for WhatsApp contact requests
CREATE TABLE public.whatsapp_requests (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  requester_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  responded_at TIMESTAMP WITH TIME ZONE,
  UNIQUE(requester_id, target_user_id)
);

-- Enable RLS
ALTER TABLE public.whatsapp_requests ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own requests (sent or received)
CREATE POLICY "Users can view their own requests"
ON public.whatsapp_requests
FOR SELECT
USING (auth.uid() = requester_id OR auth.uid() = target_user_id);

-- Policy: Users can create requests
CREATE POLICY "Users can create requests"
ON public.whatsapp_requests
FOR INSERT
WITH CHECK (auth.uid() = requester_id);

-- Policy: Target users can update requests (approve/reject)
CREATE POLICY "Target users can update requests"
ON public.whatsapp_requests
FOR UPDATE
USING (auth.uid() = target_user_id);

-- Policy: Users can delete their own sent requests
CREATE POLICY "Users can delete their own sent requests"
ON public.whatsapp_requests
FOR DELETE
USING (auth.uid() = requester_id);

-- Create function to notify users of new WhatsApp requests
CREATE OR REPLACE FUNCTION public.notify_whatsapp_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  requester_name TEXT;
BEGIN
  -- Get requester name
  SELECT full_name INTO requester_name FROM public.profiles WHERE id = NEW.requester_id;
  
  -- Create notification for target user
  INSERT INTO public.notifications (user_id, title, message, type, metadata)
  VALUES (
    NEW.target_user_id,
    '📱 WhatsApp Contact Request',
    COALESCE(requester_name, 'Someone') || ' wants to contact you on WhatsApp.' || COALESCE(' Message: ' || NEW.message, ''),
    'chat',
    jsonb_build_object(
      'request_id', NEW.id,
      'requester_id', NEW.requester_id,
      'requester_name', requester_name,
      'type', 'whatsapp_request'
    )
  );
  
  RETURN NEW;
END;
$$;

-- Create trigger for new WhatsApp requests
CREATE TRIGGER on_whatsapp_request_created
  AFTER INSERT ON public.whatsapp_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_whatsapp_request();

-- Create function to notify requester of response
CREATE OR REPLACE FUNCTION public.notify_whatsapp_request_response()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_name TEXT;
  target_phone TEXT;
BEGIN
  -- Only trigger on status change
  IF OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected') THEN
    -- Get target user info
    SELECT full_name, phone INTO target_name, target_phone FROM public.profiles WHERE id = NEW.target_user_id;
    
    IF NEW.status = 'approved' THEN
      -- Create notification for requester with phone number
      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        NEW.requester_id,
        '✅ WhatsApp Request Approved!',
        COALESCE(target_name, 'User') || ' has approved your WhatsApp contact request. You can now contact them.',
        'success',
        jsonb_build_object(
          'request_id', NEW.id,
          'target_user_id', NEW.target_user_id,
          'target_name', target_name,
          'target_phone', target_phone,
          'type', 'whatsapp_approved'
        )
      );
    ELSE
      -- Create notification for rejection
      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        NEW.requester_id,
        '❌ WhatsApp Request Declined',
        COALESCE(target_name, 'User') || ' has declined your WhatsApp contact request.',
        'info',
        jsonb_build_object(
          'request_id', NEW.id,
          'target_user_id', NEW.target_user_id,
          'type', 'whatsapp_rejected'
        )
      );
    END IF;
    
    NEW.responded_at := now();
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger for WhatsApp request responses
CREATE TRIGGER on_whatsapp_request_response
  BEFORE UPDATE ON public.whatsapp_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_whatsapp_request_response();

-- Enable realtime for whatsapp_requests table
ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_requests;