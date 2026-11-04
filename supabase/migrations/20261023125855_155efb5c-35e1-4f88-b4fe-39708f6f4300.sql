-- Close the tautological read policy on the agent weekly posting rule settings.
-- Evidence gathered before this change:
--   * No browser code selects public.agent_posting_rule_settings directly (no .from('agent_posting_rule_settings') in src/).
--   * Every function that reads it is SECURITY DEFINER (_agent_weekly_posting_compute,
--     enforce_agent_daily_eligibility, get_agent_weekly_posting_eligibility, get_my_weekly_performance),
--     so they read as the owner and are unaffected by this policy.
--   * _agent_rule_week_start is SECURITY INVOKER but is not executable by anon/authenticated.
--   * No view exposes the table.
-- The replacement predicate mirrors the established pattern for sibling config tables
-- (advance_fee_config: "Finance roles can view fee config").

DROP POLICY IF EXISTS agent_posting_rule_settings_read ON public.agent_posting_rule_settings;

CREATE POLICY agent_posting_rule_settings_read ON public.agent_posting_rule_settings
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'financial_ops')
    OR public.has_role(auth.uid(), 'super_admin')
  );