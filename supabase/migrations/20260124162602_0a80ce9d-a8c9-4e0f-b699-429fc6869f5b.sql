-- Create Welile Homes subscriptions table
CREATE TABLE public.welile_homes_subscriptions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  landlord_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  monthly_rent NUMERIC NOT NULL DEFAULT 0,
  subscription_status TEXT NOT NULL DEFAULT 'active' CHECK (subscription_status IN ('active', 'paused', 'cancelled')),
  landlord_registered BOOLEAN NOT NULL DEFAULT false,
  total_savings NUMERIC NOT NULL DEFAULT 0,
  months_enrolled INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(tenant_id)
);

-- Enable Row Level Security
ALTER TABLE public.welile_homes_subscriptions ENABLE ROW LEVEL SECURITY;

-- Tenants can view their own subscription
CREATE POLICY "Tenants can view their own subscription"
ON public.welile_homes_subscriptions
FOR SELECT
USING (auth.uid() = tenant_id);

-- Tenants can create their own subscription
CREATE POLICY "Tenants can create their own subscription"
ON public.welile_homes_subscriptions
FOR INSERT
WITH CHECK (auth.uid() = tenant_id);

-- Tenants can update their own subscription
CREATE POLICY "Tenants can update their own subscription"
ON public.welile_homes_subscriptions
FOR UPDATE
USING (auth.uid() = tenant_id);

-- Managers can view all subscriptions
CREATE POLICY "Managers can view all subscriptions"
ON public.welile_homes_subscriptions
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = auth.uid()
    AND user_roles.role = 'manager'
  )
);

-- Managers can update all subscriptions
CREATE POLICY "Managers can update all subscriptions"
ON public.welile_homes_subscriptions
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = auth.uid()
    AND user_roles.role = 'manager'
  )
);

-- Managers can delete subscriptions
CREATE POLICY "Managers can delete all subscriptions"
ON public.welile_homes_subscriptions
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = auth.uid()
    AND user_roles.role = 'manager'
  )
);

-- Create trigger for automatic timestamp updates
CREATE TRIGGER update_welile_homes_subscriptions_updated_at
BEFORE UPDATE ON public.welile_homes_subscriptions
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Enable realtime for the table
ALTER PUBLICATION supabase_realtime ADD TABLE public.welile_homes_subscriptions;