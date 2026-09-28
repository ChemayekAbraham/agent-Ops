CREATE OR REPLACE FUNCTION public.proxy_dashboard_note_house_count(p_note uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT COUNT(*)::int FROM promissory_note_house_intents WHERE note_id = p_note $$;
REVOKE ALL ON FUNCTION public.proxy_dashboard_note_house_count(uuid) FROM PUBLIC, anon, authenticated;