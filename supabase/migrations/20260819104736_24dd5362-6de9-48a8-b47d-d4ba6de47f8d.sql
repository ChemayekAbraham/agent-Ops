REVOKE ALL ON FUNCTION public.ops_recent_agent_inactivations(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_recent_agent_inactivations(integer, integer) TO authenticated;