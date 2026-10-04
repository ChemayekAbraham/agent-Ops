CREATE INDEX IF NOT EXISTS idx_agent_subagents_parent_active
ON public.agent_subagents (parent_agent_id)
WHERE parent_agent_id IS NOT NULL AND status IN ('verified', 'pending_acceptance');

CREATE INDEX IF NOT EXISTS idx_agent_subagents_sub_active
ON public.agent_subagents (sub_agent_id)
WHERE sub_agent_id IS NOT NULL AND status IN ('verified', 'pending_acceptance');