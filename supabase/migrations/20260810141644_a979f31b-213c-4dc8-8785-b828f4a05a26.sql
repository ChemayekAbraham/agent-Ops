ALTER TABLE public.landlords ADD COLUMN IF NOT EXISTS ug_village_id integer;
CREATE INDEX IF NOT EXISTS idx_landlords_ug_village_id ON public.landlords (ug_village_id);

CREATE OR REPLACE FUNCTION public.ops_update_landlord(p_landlord_id uuid, p_patch jsonb, p_reason text)
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
    'property_address','region','district','county','sub_county','village','ug_village_id',
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
    property_address         = COALESCE(NULLIF(trim(p_patch->>'property_address'), ''), property_address),
    region                   = COALESCE(NULLIF(trim(p_patch->>'region'), ''), region),
    district                 = COALESCE(NULLIF(trim(p_patch->>'district'), ''), district),
    county                   = COALESCE(NULLIF(trim(p_patch->>'county'), ''), county),
    sub_county               = COALESCE(NULLIF(trim(p_patch->>'sub_county'), ''), sub_county),
    village                  = COALESCE(NULLIF(trim(p_patch->>'village'), ''), village),
    ug_village_id            = COALESCE(NULLIF(p_patch->>'ug_village_id','')::integer, ug_village_id),
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