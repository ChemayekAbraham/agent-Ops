-- Dossier: tell Agent Ops whether the agent has ID photos on file now (has_id_photos), so
-- "Ask agent to re-upload ID" shows for agents who have photos but never submitted
-- (their agent_vetting.id_*_path are still empty). CREATE OR REPLACE keeps the grants.

CREATE OR REPLACE FUNCTION public.agent_vetting_detail(p_agent_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v  public.agent_vetting;
  p  public.profiles;
  h  public.profiles;
BEGIN
  IF NOT public.is_agent_vetting_reviewer(auth.uid()) THEN
    RAISE EXCEPTION 'Only Agent Ops can review agent verification.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v FROM public.agent_vetting WHERE agent_id = p_agent_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO p FROM public.profiles WHERE id = p_agent_id;
  SELECT * INTO h FROM public.profiles WHERE id = v.id_holder_id;

  RETURN to_jsonb(v)
    || jsonb_build_object(
      'name', p.full_name, 'profile_phone', p.phone, 'avatar_url', p.avatar_url,
      'identity_verified', public.identity_already_verified__impl(p_agent_id),
      -- The agent's ID photos as they are on the profile now. The id_*_path columns above are
      -- only refreshed at submit, so an agent who never submitted shows none there.
      'has_id_photos', (nullif(btrim(coalesce(p.national_id_photo_path, '')), '') IS NOT NULL
                        OR nullif(btrim(coalesce(p.national_id_back_photo_path, '')), '') IS NOT NULL),
      'gps_drift_m', CASE WHEN v.gps2_lat IS NOT NULL
                       THEN round(public.agent_vetting_distance_m(v.gps1_lat, v.gps1_lng, v.gps2_lat, v.gps2_lng)) END,
      'residence_pin', CASE WHEN p.residence_lat IS NOT NULL
                         THEN jsonb_build_object('lat', p.residence_lat, 'lng', p.residence_lng) END,
      'id_holder', CASE WHEN h.id IS NOT NULL THEN jsonb_build_object('id', h.id, 'name', h.full_name, 'phone', h.phone) END,
      'collections', (SELECT count(*) FROM public.agent_collections c WHERE c.agent_id = p_agent_id),
      'rent_requests', (SELECT count(*) FROM public.rent_requests r WHERE r.agent_id = p_agent_id),
      'events', coalesce((SELECT jsonb_agg(jsonb_build_object('event', e.event, 'actor_id', e.actor_id,
                                                              'detail', e.detail, 'at', e.created_at) ORDER BY e.created_at DESC)
                          FROM (SELECT * FROM public.agent_vetting_events WHERE agent_id = p_agent_id
                                ORDER BY created_at DESC LIMIT 50) e), '[]'::jsonb));
END;
$function$;
