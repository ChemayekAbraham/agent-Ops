-- Fix RLS policy for agent_subagents to allow new sub-agents to create their own relationship
-- This is needed when users sign up via the shareable link and become sub-agents

-- Drop existing insert policy
DROP POLICY IF EXISTS "Agents can insert subagents they create" ON public.agent_subagents;

-- Create new insert policy that allows:
-- 1. Parent agents to create relationships (parent_agent_id = auth.uid())
-- 2. New sub-agents to register themselves (sub_agent_id = auth.uid())
CREATE POLICY "Allow subagent relationship creation" 
ON public.agent_subagents 
FOR INSERT 
TO authenticated
WITH CHECK (
  auth.uid() = parent_agent_id 
  OR auth.uid() = sub_agent_id
);