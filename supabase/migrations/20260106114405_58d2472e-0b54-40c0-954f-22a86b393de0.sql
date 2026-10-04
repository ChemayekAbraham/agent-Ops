-- Create investment_accounts table for supporters
CREATE TABLE public.investment_accounts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'blue',
  balance NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected
  approved_at TIMESTAMP WITH TIME ZONE,
  approved_by UUID,
  rejection_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.investment_accounts ENABLE ROW LEVEL SECURITY;

-- Supporters can view their own accounts
CREATE POLICY "Users can view their own investment accounts" 
ON public.investment_accounts 
FOR SELECT 
USING (auth.uid() = user_id);

-- Supporters can create their own accounts
CREATE POLICY "Users can create their own investment accounts" 
ON public.investment_accounts 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

-- Managers can view all accounts
CREATE POLICY "Managers can view all investment accounts" 
ON public.investment_accounts 
FOR SELECT 
USING (public.has_role(auth.uid(), 'manager'));

-- Managers can update all accounts (for approval/rejection)
CREATE POLICY "Managers can update investment accounts" 
ON public.investment_accounts 
FOR UPDATE 
USING (public.has_role(auth.uid(), 'manager'));

-- Users can update their own pending accounts
CREATE POLICY "Users can update their own pending accounts" 
ON public.investment_accounts 
FOR UPDATE 
USING (auth.uid() = user_id AND status = 'pending');

-- Create trigger for automatic timestamp updates
CREATE TRIGGER update_investment_accounts_updated_at
BEFORE UPDATE ON public.investment_accounts
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create function to notify managers of new investment account
CREATE OR REPLACE FUNCTION public.notify_new_investment_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  manager_record RECORD;
  supporter_name TEXT;
BEGIN
  -- Get supporter name
  SELECT full_name INTO supporter_name FROM public.profiles WHERE id = NEW.user_id;
  
  -- Notify all managers
  FOR manager_record IN 
    SELECT user_id FROM public.user_roles WHERE role = 'manager'
  LOOP
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      manager_record.user_id,
      '📊 New Investment Account',
      COALESCE(supporter_name, 'A supporter') || ' has created a new investment account "' || NEW.name || '" pending approval.',
      'info',
      jsonb_build_object('account_id', NEW.id, 'supporter_id', NEW.user_id, 'account_name', NEW.name)
    );
  END LOOP;
  
  RETURN NEW;
END;
$$;

-- Create trigger to notify managers
CREATE TRIGGER notify_new_investment_account_trigger
AFTER INSERT ON public.investment_accounts
FOR EACH ROW
EXECUTE FUNCTION public.notify_new_investment_account();