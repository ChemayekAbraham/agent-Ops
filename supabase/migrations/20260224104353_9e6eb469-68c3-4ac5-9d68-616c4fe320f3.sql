
-- Fix overly permissive onboarding_targets policy
DROP POLICY IF EXISTS "System can manage targets" ON public.onboarding_targets;

-- Replace with manager-only access
CREATE POLICY "Managers can manage targets" ON public.onboarding_targets
  FOR ALL USING (has_role(auth.uid(), 'manager'::app_role))
  WITH CHECK (has_role(auth.uid(), 'manager'::app_role));

-- Also add agent read-only access for their own targets
CREATE POLICY "Agents can view own targets" ON public.onboarding_targets
  FOR SELECT USING (auth.uid() = agent_id);
