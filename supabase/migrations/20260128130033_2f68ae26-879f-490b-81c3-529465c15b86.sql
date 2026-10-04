-- Add parent_agent_id column to supporter_invites for sub-agent tracking
ALTER TABLE public.supporter_invites 
ADD COLUMN IF NOT EXISTS parent_agent_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_supporter_invites_parent_agent 
ON public.supporter_invites(parent_agent_id) 
WHERE parent_agent_id IS NOT NULL;

COMMENT ON COLUMN public.supporter_invites.parent_agent_id IS 'For sub-agent invites, stores the parent agent ID who created the invite';