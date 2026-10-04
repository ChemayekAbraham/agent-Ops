REVOKE EXECUTE ON FUNCTION public.agent_ops_open_report(text, date) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.agent_ops_submit_report(uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.agent_ops_carry_actions(uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.agent_ops_prior_report(text, date) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.agent_ops_open_report(text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_ops_submit_report(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_ops_carry_actions(uuid) TO authenticated;