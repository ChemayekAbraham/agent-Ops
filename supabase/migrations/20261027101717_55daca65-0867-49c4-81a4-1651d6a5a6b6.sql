DROP POLICY IF EXISTS agent_vetting_settings_read ON public.agent_vetting_settings;
CREATE POLICY agent_vetting_settings_read ON public.agent_vetting_settings
  FOR SELECT TO authenticated
  USING (public.is_agent_vetting_reviewer((select auth.uid())));