CREATE TABLE public.agent_team_goals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  goal_week DATE NOT NULL,
  target_registrations INTEGER NOT NULL DEFAULT 0,
  target_earnings NUMERIC NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (agent_id, goal_week)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_team_goals TO authenticated;
GRANT ALL ON public.agent_team_goals TO service_role;

ALTER TABLE public.agent_team_goals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents manage their own team goals"
ON public.agent_team_goals FOR ALL
USING (auth.uid() = agent_id)
WITH CHECK (auth.uid() = agent_id);

CREATE TRIGGER update_agent_team_goals_updated_at
BEFORE UPDATE ON public.agent_team_goals
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();