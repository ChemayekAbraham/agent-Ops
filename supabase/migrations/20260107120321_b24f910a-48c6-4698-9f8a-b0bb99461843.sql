-- Create table for pending supporter invites
CREATE TABLE public.supporter_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  temp_password TEXT NOT NULL,
  activation_token UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  activated_at TIMESTAMP WITH TIME ZONE,
  activated_user_id UUID,
  status TEXT DEFAULT 'pending' NOT NULL
);

-- Enable RLS
ALTER TABLE public.supporter_invites ENABLE ROW LEVEL SECURITY;

-- Managers can view and create invites
CREATE POLICY "Managers can view all invites"
ON public.supporter_invites
FOR SELECT
USING (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Managers can create invites"
ON public.supporter_invites
FOR INSERT
WITH CHECK (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Managers can update invites"
ON public.supporter_invites
FOR UPDATE
USING (public.has_role(auth.uid(), 'manager'));

-- Public can view pending invites by token (for activation)
CREATE POLICY "Anyone can view invite by token"
ON public.supporter_invites
FOR SELECT
USING (status = 'pending');