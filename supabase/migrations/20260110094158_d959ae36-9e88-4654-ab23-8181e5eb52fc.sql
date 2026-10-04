-- Create agent_goals table for tracking registration targets
CREATE TABLE public.agent_goals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  goal_month DATE NOT NULL, -- First day of the month (e.g., 2026-01-01)
  target_registrations INTEGER NOT NULL DEFAULT 10,
  target_activations INTEGER DEFAULT NULL,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(agent_id, goal_month)
);

-- Enable RLS
ALTER TABLE public.agent_goals ENABLE ROW LEVEL SECURITY;

-- Agents can manage their own goals
CREATE POLICY "Agents can view their own goals"
ON public.agent_goals FOR SELECT
USING (auth.uid() = agent_id);

CREATE POLICY "Agents can create their own goals"
ON public.agent_goals FOR INSERT
WITH CHECK (auth.uid() = agent_id);

CREATE POLICY "Agents can update their own goals"
ON public.agent_goals FOR UPDATE
USING (auth.uid() = agent_id);

CREATE POLICY "Agents can delete their own goals"
ON public.agent_goals FOR DELETE
USING (auth.uid() = agent_id);

-- Managers can view all agent goals
CREATE POLICY "Managers can view all agent goals"
ON public.agent_goals FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'manager'
  )
);

-- Add trigger for updated_at
CREATE TRIGGER update_agent_goals_updated_at
BEFORE UPDATE ON public.agent_goals
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();