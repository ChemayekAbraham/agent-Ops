-- Close privilege-escalation hole: client-side inserts into agent_subagents could
-- carry status 'verified' (the old column default), letting any user attach
-- themselves as a verified sub-agent under any parent without the invite flow.
-- New rule: direct inserts are always 'pending'; verification happens only via
-- the staff update policy / invite-acceptance flow.
ALTER TABLE public.agent_subagents ALTER COLUMN status SET DEFAULT 'pending';

DROP POLICY "Allow subagent relationship creation" ON public.agent_subagents;
CREATE POLICY "Allow subagent relationship creation" ON public.agent_subagents
  FOR INSERT TO authenticated
  WITH CHECK ((auth.uid() = parent_agent_id OR auth.uid() = sub_agent_id) AND status = 'pending');