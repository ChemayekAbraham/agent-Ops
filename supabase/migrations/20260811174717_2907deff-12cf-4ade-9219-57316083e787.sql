CREATE OR REPLACE FUNCTION public.agent_update_tenant_property(
  p_request_id uuid,
  p_house_category text DEFAULT NULL,
  p_village text DEFAULT NULL,
  p_sub_county text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_ug_village_id integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req record;
  v_old record;
  v_address text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT id, agent_id, assigned_agent_id, landlord_id, user_id
    INTO v_req
  FROM public.rent_requests
  WHERE id = p_request_id;

  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'Rent plan not found';
  END IF;
  IF v_req.landlord_id IS NULL THEN
    RAISE EXCEPTION 'This rent plan has no property record to edit';
  END IF;

  IF NOT (
    v_uid = v_req.agent_id
    OR v_uid = v_req.assigned_agent_id
    OR EXISTS (
      SELECT 1 FROM public.agent_subagents s
      WHERE s.parent_agent_id = v_uid
        AND s.subagent_id IN (v_req.agent_id, v_req.assigned_agent_id)
    )
    OR has_role(v_uid, 'operations'::app_role)
    OR has_role(v_uid, 'manager'::app_role)
    OR has_role(v_uid, 'coo'::app_role)
    OR has_role(v_uid, 'ceo'::app_role)
    OR has_role(v_uid, 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'Only the agent handling this tenant can edit these property details';
  END IF;

  SELECT house_category, property_address, village, sub_county, district, ug_village_id
    INTO v_old
  FROM public.landlords
  WHERE id = v_req.landlord_id;

  v_address := NULLIF(
    concat_ws(', ',
      NULLIF(btrim(coalesce(p_village, v_old.village, '')), ''),
      NULLIF(btrim(coalesce(p_sub_county, v_old.sub_county, '')), ''),
      NULLIF(btrim(coalesce(p_district, v_old.district, '')), '')
    ), '');

  UPDATE public.landlords
  SET house_category = coalesce(NULLIF(btrim(coalesce(p_house_category, '')), ''), house_category),
      village        = coalesce(NULLIF(btrim(coalesce(p_village, '')), ''), village),
      sub_county     = coalesce(NULLIF(btrim(coalesce(p_sub_county, '')), ''), sub_county),
      district       = coalesce(NULLIF(btrim(coalesce(p_district, '')), ''), district),
      ug_village_id  = coalesce(p_ug_village_id, ug_village_id),
      property_address = coalesce(v_address, property_address),
      updated_at = now()
  WHERE id = v_req.landlord_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, old_values, new_values, reason)
  VALUES (
    v_uid,
    'agent_property_detail_update',
    'landlords',
    v_req.landlord_id,
    to_jsonb(v_old),
    jsonb_build_object(
      'house_category', coalesce(NULLIF(btrim(coalesce(p_house_category, '')), ''), v_old.house_category),
      'village', coalesce(NULLIF(btrim(coalesce(p_village, '')), ''), v_old.village),
      'sub_county', coalesce(NULLIF(btrim(coalesce(p_sub_county, '')), ''), v_old.sub_county),
      'district', coalesce(NULLIF(btrim(coalesce(p_district, '')), ''), v_old.district),
      'ug_village_id', coalesce(p_ug_village_id, v_old.ug_village_id),
      'property_address', coalesce(v_address, v_old.property_address)
    ),
    'agent property detail correction'
  );

  RETURN jsonb_build_object('success', true, 'landlord_id', v_req.landlord_id, 'property_address', coalesce(v_address, v_old.property_address));
END;
$$;

REVOKE ALL ON FUNCTION public.agent_update_tenant_property(uuid, text, text, text, text, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.agent_update_tenant_property(uuid, text, text, text, text, integer) TO authenticated;