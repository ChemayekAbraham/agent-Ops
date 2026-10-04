REVOKE ALL ON FUNCTION public.staff_requisition_route(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_requisition_route(uuid) TO authenticated, service_role;