-- Create table to track manager investment requests from supporters
CREATE TABLE public.manager_investment_requests (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  supporter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  supporter_name TEXT,
  supporter_phone TEXT,
  amount NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'rejected')),
  manager_id UUID REFERENCES auth.users(id),
  manager_notes TEXT,
  investment_account_id UUID REFERENCES public.investment_accounts(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  processed_at TIMESTAMP WITH TIME ZONE
);

-- Enable RLS
ALTER TABLE public.manager_investment_requests ENABLE ROW LEVEL SECURITY;

-- Supporters can view their own requests
CREATE POLICY "Supporters can view their own requests"
ON public.manager_investment_requests
FOR SELECT
USING (auth.uid() = supporter_id);

-- Supporters can create requests
CREATE POLICY "Supporters can create requests"
ON public.manager_investment_requests
FOR INSERT
WITH CHECK (auth.uid() = supporter_id);

-- Managers can view all requests
CREATE POLICY "Managers can view all requests"
ON public.manager_investment_requests
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'manager' AND enabled = true
  )
);

-- Managers can update requests
CREATE POLICY "Managers can update requests"
ON public.manager_investment_requests
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'manager' AND enabled = true
  )
);

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.manager_investment_requests;