REVOKE ALL ON FUNCTION public.agent_ops_can_view_rent_behaviour(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_agent_ops_rent_behaviour(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_agent_ops_rent_behaviour_detail(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agent_ops_can_view_rent_behaviour(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_agent_ops_rent_behaviour(integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.get_agent_ops_rent_behaviour_detail(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.agent_ops_can_view_rent_behaviour(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_ops_rent_behaviour(integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_ops_rent_behaviour_detail(uuid, uuid) TO authenticated;