-- Add agent_type column to profiles for labeling agents
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS agent_type TEXT DEFAULT NULL;

-- Add comment for clarity
COMMENT ON COLUMN public.profiles.agent_type IS 'Agent classification: signage (has Welile signage at location) or mobile (moves around)';