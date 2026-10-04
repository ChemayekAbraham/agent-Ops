-- Create function to notify managers of new deposit requests
CREATE OR REPLACE FUNCTION public.notify_managers_new_deposit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  manager_record RECORD;
  depositor_name TEXT;
BEGIN
  -- Get depositor name
  SELECT full_name INTO depositor_name FROM public.profiles WHERE id = NEW.user_id;
  
  -- Notify all managers
  FOR manager_record IN 
    SELECT user_id FROM public.user_roles WHERE role = 'manager'
  LOOP
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      manager_record.user_id,
      '💰 New Deposit Request',
      COALESCE(depositor_name, 'A user') || ' has requested a deposit of UGX ' || NEW.amount::text || '.',
      'info',
      jsonb_build_object('deposit_request_id', NEW.id, 'user_id', NEW.user_id, 'amount', NEW.amount)
    );
  END LOOP;
  
  RETURN NEW;
END;
$$;

-- Create trigger for new deposit requests
DROP TRIGGER IF EXISTS notify_managers_on_new_deposit ON public.deposit_requests;
CREATE TRIGGER notify_managers_on_new_deposit
  AFTER INSERT ON public.deposit_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_managers_new_deposit();