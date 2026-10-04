-- Add role column to supporter_invites table
ALTER TABLE public.supporter_invites 
ADD COLUMN role text NOT NULL DEFAULT 'supporter';

-- Add check constraint for valid roles
ALTER TABLE public.supporter_invites 
ADD CONSTRAINT valid_invite_role CHECK (role IN ('tenant', 'agent', 'supporter'));