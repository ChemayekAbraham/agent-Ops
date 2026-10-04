CREATE TABLE public.agent_capacity_targets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  target_type TEXT NOT NULL DEFAULT 'ugx',
  target_value NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT agent_capacity_targets_type_chk CHECK (target_type IN ('ugx', 'slots')),
  CONSTRAINT agent_capacity_targets_value_chk CHECK (target_value >= 0)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_capacity_targets TO authenticated;
GRANT ALL ON public.agent_capacity_targets TO service_role;

ALTER TABLE public.agent_capacity_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents view their own capacity target"
ON public.agent_capacity_targets
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Agents insert their own capacity target"
ON public.agent_capacity_targets
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Agents update their own capacity target"
ON public.agent_capacity_targets
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Agents delete their own capacity target"
ON public.agent_capacity_targets
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);

CREATE TRIGGER update_agent_capacity_targets_updated_at
BEFORE UPDATE ON public.agent_capacity_targets
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();