CREATE OR REPLACE FUNCTION public.get_service_center_listing_queue(p_manager_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_manager uuid := COALESCE(p_manager_id, auth.uid());
  v_out jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_manager <> v_actor AND NOT public.is_ops_role(v_actor) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at' DESC), '[]'::jsonb) INTO v_out
  FROM (
    SELECT jsonb_build_object(
      'id', h.id,
      'title', h.title,
      'district', h.district,
      'address', h.address,
      'village', h.village,
      'rent_amount', h.monthly_rent,
      'bedrooms', h.number_of_rooms,
      'images', h.image_urls,
      'latitude', h.latitude,
      'longitude', h.longitude,
      'created_at', h.created_at,
      'agent_id', h.agent_id,
      'agent_name', ap.full_name,
      'agent_phone', ap.phone,
      'landlord_id', h.landlord_id,
      'landlord_name', lp.full_name,
      'landlord_phone', lp.phone,
      'service_center_status', h.service_center_status
    ) AS x
    FROM public.house_listings h
    LEFT JOIN public.profiles ap ON ap.id = h.agent_id
    LEFT JOIN public.profiles lp ON lp.id = h.landlord_id
    WHERE h.service_center_status = 'pending'
      AND h.service_center_manager_id = v_manager
      AND COALESCE(h.verified, false) = false
      AND COALESCE(h.status,'available') NOT IN ('rejected','delisted')
    ORDER BY h.created_at DESC
    LIMIT 200
  ) s;

  RETURN v_out;
END;
$fn$;