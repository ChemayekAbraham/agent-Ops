-- Add enabled column to user_roles table to allow managers to disable specific roles
ALTER TABLE public.user_roles 
ADD COLUMN enabled boolean NOT NULL DEFAULT true;

-- Add a comment to explain the column
COMMENT ON COLUMN public.user_roles.enabled IS 'When false, the user cannot access this role''s dashboard even though the role is assigned';

-- Create an index for faster lookups of enabled roles
CREATE INDEX idx_user_roles_enabled ON public.user_roles(user_id, enabled) WHERE enabled = true;