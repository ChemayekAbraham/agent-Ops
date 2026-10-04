-- Add source column to track how sub-agents were registered
ALTER TABLE public.agent_subagents 
ADD COLUMN source text NOT NULL DEFAULT 'invite';

-- Add a comment for clarity
COMMENT ON COLUMN public.agent_subagents.source IS 'How the sub-agent was registered: link (self-signup via shareable link) or invite (direct registration by parent agent)';