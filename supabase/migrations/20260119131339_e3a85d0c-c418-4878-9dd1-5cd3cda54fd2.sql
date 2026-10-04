-- Create table for sub-agent team goals
CREATE TABLE public.subagent_team_goals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID NOT NULL,
  goal_month DATE NOT NULL,
  target_registrations INTEGER NOT NULL DEFAULT 0,
  target_earnings NUMERIC NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(agent_id, goal_month)
);

-- Enable RLS
ALTER TABLE public.subagent_team_goals ENABLE ROW LEVEL SECURITY;

-- Agents can view their own goals
CREATE POLICY "Agents can view their own team goals"
ON public.subagent_team_goals
FOR SELECT
USING (auth.uid() = agent_id);

-- Agents can create their own goals
CREATE POLICY "Agents can create their own team goals"
ON public.subagent_team_goals
FOR INSERT
WITH CHECK (auth.uid() = agent_id);

-- Agents can update their own goals
CREATE POLICY "Agents can update their own team goals"
ON public.subagent_team_goals
FOR UPDATE
USING (auth.uid() = agent_id);

-- Agents can delete their own goals
CREATE POLICY "Agents can delete their own team goals"
ON public.subagent_team_goals
FOR DELETE
USING (auth.uid() = agent_id);

-- Add trigger for updated_at
CREATE TRIGGER update_subagent_team_goals_updated_at
BEFORE UPDATE ON public.subagent_team_goals
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();