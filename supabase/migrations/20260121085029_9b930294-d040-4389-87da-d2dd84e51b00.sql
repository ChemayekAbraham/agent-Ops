-- Drop the existing check constraint
ALTER TABLE public.supporter_invites DROP CONSTRAINT IF EXISTS valid_invite_role;

-- Add a new check constraint that allows all valid roles
ALTER TABLE public.supporter_invites ADD CONSTRAINT valid_invite_role 
  CHECK (role IN ('supporter', 'agent', 'tenant', 'landlord', 'manager'));