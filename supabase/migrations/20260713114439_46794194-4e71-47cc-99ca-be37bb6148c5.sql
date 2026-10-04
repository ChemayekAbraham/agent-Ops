GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_team_goals TO authenticated;
GRANT ALL ON public.agent_team_goals TO service_role;

DROP POLICY IF EXISTS "Agents manage their own team goals" ON public.agent_team_goals;
DROP POLICY IF EXISTS "Agents can view own team goals" ON public.agent_team_goals;
DROP POLICY IF EXISTS "Agents can create own team goals" ON public.agent_team_goals;
DROP POLICY IF EXISTS "Agents can update own team goals" ON public.agent_team_goals;
DROP POLICY IF EXISTS "Agents can delete own team goals" ON public.agent_team_goals;

CREATE POLICY "Agents can view own team goals"
ON public.agent_team_goals
FOR SELECT
TO authenticated
USING (auth.uid() = agent_id);

CREATE POLICY "Agents can create own team goals"
ON public.agent_team_goals
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = agent_id);

CREATE POLICY "Agents can update own team goals"
ON public.agent_team_goals
FOR UPDATE
TO authenticated
USING (auth.uid() = agent_id)
WITH CHECK (auth.uid() = agent_id);

CREATE POLICY "Agents can delete own team goals"
ON public.agent_team_goals
FOR DELETE
TO authenticated
USING (auth.uid() = agent_id);