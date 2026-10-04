-- Create a function to notify managers when a new user signs up
CREATE OR REPLACE FUNCTION public.notify_managers_on_signup()
RETURNS TRIGGER AS $$
DECLARE
  manager_id UUID;
BEGIN
  -- Get all manager user IDs and insert notifications for each
  FOR manager_id IN 
    SELECT user_id FROM public.user_roles WHERE role = 'manager' AND enabled = true
  LOOP
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      manager_id,
      'New User Signup',
      'New user ' || NEW.full_name || ' (' || NEW.phone || ') has registered.',
      'signup',
      jsonb_build_object('new_user_id', NEW.id, 'full_name', NEW.full_name, 'phone', NEW.phone, 'email', NEW.email)
    );
  END LOOP;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger to fire after new profile is inserted
DROP TRIGGER IF EXISTS on_new_user_signup ON public.profiles;
CREATE TRIGGER on_new_user_signup
  AFTER INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_managers_on_signup();