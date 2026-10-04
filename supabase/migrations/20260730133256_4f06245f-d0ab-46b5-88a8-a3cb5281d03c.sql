CREATE OR REPLACE FUNCTION public.ops_update_agent_profile(p_agent_id uuid, p_updates jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_allowed text[] := ARRAY['full_name','phone','email','national_id','mobile_money_number','mobile_money_name','mobile_money_provider','region','district','sub_county','village','territory','occupation'];
  v_key text;
  v_clean jsonb := '{}'::jsonb;
  v_old jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF NOT (
    public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'agent_ops') OR public.has_role(auth.uid(), 'operations')
    OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'hr')
  ) THEN
    RAISE EXCEPTION 'Not authorised to edit agent profiles';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_updates) LOOP
    IF v_key = ANY(v_allowed) THEN
      v_clean := v_clean || jsonb_build_object(v_key, NULLIF(btrim(coalesce(p_updates ->> v_key, '')), ''));
    END IF;
  END LOOP;

  IF v_clean = '{}'::jsonb THEN RAISE EXCEPTION 'No editable fields supplied'; END IF;

  SELECT to_jsonb(p) INTO v_old FROM public.profiles p WHERE p.id = p_agent_id;
  IF v_old IS NULL THEN RAISE EXCEPTION 'Profile not found'; END IF;

  UPDATE public.profiles p
  SET full_name = COALESCE(v_clean ->> 'full_name', p.full_name),
      phone = COALESCE(v_clean ->> 'phone', p.phone),
      email = COALESCE(v_clean ->> 'email', p.email),
      national_id = CASE WHEN v_clean ? 'national_id' THEN v_clean ->> 'national_id' ELSE p.national_id END,
      mobile_money_number = CASE WHEN v_clean ? 'mobile_money_number' THEN v_clean ->> 'mobile_money_number' ELSE p.mobile_money_number END,
      mobile_money_name = CASE WHEN v_clean ? 'mobile_money_name' THEN v_clean ->> 'mobile_money_name' ELSE p.mobile_money_name END,
      mobile_money_provider = CASE WHEN v_clean ? 'mobile_money_provider' THEN v_clean ->> 'mobile_money_provider' ELSE p.mobile_money_provider END,
      region = CASE WHEN v_clean ? 'region' THEN v_clean ->> 'region' ELSE p.region END,
      district = CASE WHEN v_clean ? 'district' THEN v_clean ->> 'district' ELSE p.district END,
      sub_county = CASE WHEN v_clean ? 'sub_county' THEN v_clean ->> 'sub_county' ELSE p.sub_county END,
      village = CASE WHEN v_clean ? 'village' THEN v_clean ->> 'village' ELSE p.village END,
      territory = CASE WHEN v_clean ? 'territory' THEN v_clean ->> 'territory' ELSE p.territory END,
      occupation = CASE WHEN v_clean ? 'occupation' THEN v_clean ->> 'occupation' ELSE p.occupation END,
      updated_at = now()
  WHERE p.id = p_agent_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (auth.uid(), 'agent_profile_edited_by_ops', 'profiles', p_agent_id,
          jsonb_build_object('changes', v_clean, 'reason', 'Agent Ops profile edit'));

  RETURN jsonb_build_object('success', true, 'updated', v_clean);
END;
$$;

GRANT EXECUTE ON FUNCTION public.ops_update_agent_profile(uuid, jsonb) TO authenticated;