DROP FUNCTION IF EXISTS public.ug_search_villages(text, integer);

GRANT EXECUTE ON FUNCTION public.ug_search_villages(text, integer, integer, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ug_resolve_village(integer) TO anon, authenticated, service_role;