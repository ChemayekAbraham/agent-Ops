
-- Add ops_note column to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS ops_note text;

-- Extend ops_update_user_identity to accept avatar_url and ops_note
CREATE OR REPLACE FUNCTION public.ops_update_user_identity(
  p_user_id uuid,
  p_full_name text,
  p_phone text,
  p_reason text,
  p_avatar_url text DEFAULT NULL,
  p_ops_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_old_name text;
  v_old_phone text;
  v_old_avatar text;
  v_old_note text;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_ops_role(v_caller) THEN RAISE EXCEPTION 'Only ops roles can edit user identity'; END IF;
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'p_user_id required'; END IF;
  IF coalesce(length(trim(p_reason)), 0) < 10 THEN RAISE EXCEPTION 'Reason must be at least 10 characters'; END IF;

  SELECT full_name, phone, avatar_url, ops_note
    INTO v_old_name, v_old_phone, v_old_avatar, v_old_note
  FROM public.profiles WHERE id = p_user_id;

  UPDATE public.profiles
  SET
    full_name  = COALESCE(NULLIF(trim(p_full_name), ''), full_name),
    phone      = COALESCE(NULLIF(trim(p_phone), ''), phone),
    avatar_url = CASE WHEN p_avatar_url IS NULL THEN avatar_url
                      WHEN trim(p_avatar_url) = '' THEN NULL
                      ELSE trim(p_avatar_url) END,
    ops_note   = CASE WHEN p_ops_note IS NULL THEN ops_note
                      WHEN trim(p_ops_note) = '' THEN NULL
                      ELSE trim(p_ops_note) END,
    updated_at = now()
  WHERE id = p_user_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, reason, performed_by, metadata)
  VALUES (
    'ops_update_user_identity', 'profiles', p_user_id, trim(p_reason), v_caller,
    jsonb_build_object(
      'old_full_name', v_old_name, 'new_full_name', NULLIF(trim(p_full_name), ''),
      'old_phone', v_old_phone,    'new_phone',     NULLIF(trim(p_phone), ''),
      'old_avatar_url', v_old_avatar, 'new_avatar_url', p_avatar_url,
      'old_ops_note', v_old_note,  'new_ops_note',   p_ops_note
    )
  );

  INSERT INTO public.system_events (event_type, aggregate_type, aggregate_id, actor_id, payload)
  VALUES ('user.identity.updated', 'profile', p_user_id, v_caller,
          jsonb_build_object('reason', trim(p_reason)));

  RETURN jsonb_build_object('success', true);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.ops_update_user_identity(uuid, text, text, text, text, text) TO authenticated;

-- New: ops_update_landlord — partial update via jsonb patch
CREATE OR REPLACE FUNCTION public.ops_update_landlord(
  p_landlord_id uuid,
  p_patch jsonb,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_old jsonb;
  v_allowed text[] := ARRAY[
    'name','phone','mobile_money_number','mobile_money_name',
    'property_address','district','sub_county','village',
    'monthly_rent','bank_name','account_number',
    'description','number_of_rooms',
    'caretaker_name','caretaker_phone',
    'electricity_meter_number','water_meter_number','house_number'
  ];
  v_key text;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_ops_role(v_caller) THEN RAISE EXCEPTION 'Only ops roles can edit landlord'; END IF;
  IF p_landlord_id IS NULL THEN RAISE EXCEPTION 'p_landlord_id required'; END IF;
  IF coalesce(length(trim(p_reason)), 0) < 10 THEN RAISE EXCEPTION 'Reason must be at least 10 characters'; END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb THEN
    RAISE EXCEPTION 'p_patch must be a non-empty JSON object';
  END IF;

  -- Validate keys
  FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
    IF NOT (v_key = ANY(v_allowed)) THEN
      RAISE EXCEPTION 'Field not editable: %', v_key;
    END IF;
  END LOOP;

  SELECT to_jsonb(l) INTO v_old FROM public.landlords l WHERE id = p_landlord_id;
  IF v_old IS NULL THEN RAISE EXCEPTION 'Landlord not found'; END IF;

  UPDATE public.landlords SET
    name                     = COALESCE(NULLIF(trim(p_patch->>'name'), ''), name),
    phone                    = COALESCE(NULLIF(trim(p_patch->>'phone'), ''), phone),
    mobile_money_number      = CASE WHEN p_patch ? 'mobile_money_number' THEN NULLIF(trim(p_patch->>'mobile_money_number'),'') ELSE mobile_money_number END,
    mobile_money_name        = CASE WHEN p_patch ? 'mobile_money_name'   THEN NULLIF(trim(p_patch->>'mobile_money_name'),'')   ELSE mobile_money_name END,
    property_address         = CASE WHEN p_patch ? 'property_address'    THEN NULLIF(trim(p_patch->>'property_address'),'')    ELSE property_address END,
    district                 = CASE WHEN p_patch ? 'district'            THEN NULLIF(trim(p_patch->>'district'),'')            ELSE district END,
    sub_county               = CASE WHEN p_patch ? 'sub_county'          THEN NULLIF(trim(p_patch->>'sub_county'),'')          ELSE sub_county END,
    village                  = CASE WHEN p_patch ? 'village'             THEN NULLIF(trim(p_patch->>'village'),'')             ELSE village END,
    monthly_rent             = CASE WHEN p_patch ? 'monthly_rent'        THEN NULLIF(p_patch->>'monthly_rent','')::numeric    ELSE monthly_rent END,
    bank_name                = CASE WHEN p_patch ? 'bank_name'           THEN NULLIF(trim(p_patch->>'bank_name'),'')           ELSE bank_name END,
    account_number           = CASE WHEN p_patch ? 'account_number'      THEN NULLIF(trim(p_patch->>'account_number'),'')      ELSE account_number END,
    description              = CASE WHEN p_patch ? 'description'         THEN NULLIF(trim(p_patch->>'description'),'')         ELSE description END,
    number_of_rooms          = CASE WHEN p_patch ? 'number_of_rooms'     THEN NULLIF(p_patch->>'number_of_rooms','')::int     ELSE number_of_rooms END,
    caretaker_name           = CASE WHEN p_patch ? 'caretaker_name'      THEN NULLIF(trim(p_patch->>'caretaker_name'),'')      ELSE caretaker_name END,
    caretaker_phone          = CASE WHEN p_patch ? 'caretaker_phone'     THEN NULLIF(trim(p_patch->>'caretaker_phone'),'')     ELSE caretaker_phone END,
    electricity_meter_number = CASE WHEN p_patch ? 'electricity_meter_number' THEN NULLIF(trim(p_patch->>'electricity_meter_number'),'') ELSE electricity_meter_number END,
    water_meter_number       = CASE WHEN p_patch ? 'water_meter_number'  THEN NULLIF(trim(p_patch->>'water_meter_number'),'')  ELSE water_meter_number END,
    house_number             = CASE WHEN p_patch ? 'house_number'        THEN NULLIF(trim(p_patch->>'house_number'),'')        ELSE house_number END,
    updated_at = now()
  WHERE id = p_landlord_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, reason, performed_by, metadata)
  VALUES ('ops_update_landlord', 'landlords', p_landlord_id, trim(p_reason), v_caller,
          jsonb_build_object('old', v_old, 'patch', p_patch));

  INSERT INTO public.system_events (event_type, aggregate_type, aggregate_id, actor_id, payload)
  VALUES ('landlord.profile_edited', 'landlord', p_landlord_id, v_caller,
          jsonb_build_object('reason', trim(p_reason), 'fields', (SELECT jsonb_agg(k) FROM jsonb_object_keys(p_patch) k)));

  RETURN jsonb_build_object('success', true);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.ops_update_landlord(uuid, jsonb, text) TO authenticated;
