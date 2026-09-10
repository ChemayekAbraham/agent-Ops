CREATE OR REPLACE FUNCTION public.guard_landlord_agreement_backed_changes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  a public.landlord_agreements;
  v_changed text[] := ARRAY[]::text[];
  v_unbacked text[] := ARRAY[]::text[];
  v_actor uuid := auth.uid();
BEGIN
  SELECT * INTO a
  FROM public.landlord_agreements
  WHERE landlord_id = NEW.id AND is_current = true AND status = 'active'
  ORDER BY sequence_no DESC
  LIMIT 1;

  IF a.id IS NULL THEN
    RETURN NEW;
  END IF;

  IF COALESCE(btrim(NEW.name), '') <> COALESCE(btrim(OLD.name), '') THEN
    v_changed := v_changed || 'name'::text;
    IF lower(COALESCE(btrim(NEW.name), '')) <> lower(COALESCE(btrim(a.landlord_name), '')) THEN
      v_unbacked := v_unbacked || 'name'::text;
    END IF;
  END IF;

  IF COALESCE(btrim(NEW.phone), '') <> COALESCE(btrim(OLD.phone), '') THEN
    v_changed := v_changed || 'phone'::text;
    IF right(regexp_replace(COALESCE(NEW.phone, ''), '\D', '', 'g'), 9)
       <> right(regexp_replace(COALESCE(a.landlord_phone, ''), '\D', '', 'g'), 9) THEN
      v_unbacked := v_unbacked || 'phone'::text;
    END IF;
  END IF;

  IF COALESCE(btrim(NEW.property_address), '') <> COALESCE(btrim(OLD.property_address), '') THEN
    v_changed := v_changed || 'property_address'::text;
    IF lower(COALESCE(btrim(NEW.property_address), '')) <> lower(COALESCE(btrim(a.property_address), '')) THEN
      v_unbacked := v_unbacked || 'property_address'::text;
    END IF;
  END IF;

  IF COALESCE(btrim(NEW.house_number), '') <> COALESCE(btrim(OLD.house_number), '') THEN
    v_changed := v_changed || 'house_number'::text;
    IF lower(COALESCE(btrim(NEW.house_number), '')) <> lower(COALESCE(btrim(a.house_number), '')) THEN
      v_unbacked := v_unbacked || 'house_number'::text;
    END IF;
  END IF;

  IF COALESCE(btrim(NEW.house_category), '') <> COALESCE(btrim(OLD.house_category), '') THEN
    v_changed := v_changed || 'house_category'::text;
    IF lower(COALESCE(btrim(NEW.house_category), '')) <> lower(COALESCE(btrim(a.house_category), '')) THEN
      v_unbacked := v_unbacked || 'house_category'::text;
    END IF;
  END IF;

  IF COALESCE(NEW.number_of_rooms, -1) <> COALESCE(OLD.number_of_rooms, -1) THEN
    v_changed := v_changed || 'number_of_rooms'::text;
    IF COALESCE(NEW.number_of_rooms, -1) <> COALESCE(a.number_of_rooms, -1) THEN
      v_unbacked := v_unbacked || 'number_of_rooms'::text;
    END IF;
  END IF;

  IF COALESCE(NEW.monthly_rent, -1) <> COALESCE(OLD.monthly_rent, -1) THEN
    v_changed := v_changed || 'monthly_rent'::text;
    IF COALESCE(NEW.monthly_rent, -1) <> COALESCE(a.monthly_rent, -1) THEN
      v_unbacked := v_unbacked || 'monthly_rent'::text;
    END IF;
  END IF;

  IF COALESCE(btrim(NEW.bank_name), '') <> COALESCE(btrim(OLD.bank_name), '') THEN
    v_changed := v_changed || 'bank_name'::text;
    IF lower(COALESCE(btrim(NEW.bank_name), '')) <> lower(COALESCE(btrim(a.bank_name), '')) THEN
      v_unbacked := v_unbacked || 'bank_name'::text;
    END IF;
  END IF;

  IF COALESCE(btrim(NEW.account_number), '') <> COALESCE(btrim(OLD.account_number), '') THEN
    v_changed := v_changed || 'account_number'::text;
    IF COALESCE(btrim(NEW.account_number), '') <> COALESCE(btrim(a.account_number), '') THEN
      v_unbacked := v_unbacked || 'account_number'::text;
    END IF;
  END IF;

  IF COALESCE(btrim(NEW.mobile_money_name), '') <> COALESCE(btrim(OLD.mobile_money_name), '') THEN
    v_changed := v_changed || 'mobile_money_name'::text;
    IF lower(COALESCE(btrim(NEW.mobile_money_name), '')) <> lower(COALESCE(btrim(a.mobile_money_name), '')) THEN
      v_unbacked := v_unbacked || 'mobile_money_name'::text;
    END IF;
  END IF;

  IF COALESCE(btrim(NEW.mobile_money_number), '') <> COALESCE(btrim(OLD.mobile_money_number), '') THEN
    v_changed := v_changed || 'mobile_money_number'::text;
    IF right(regexp_replace(COALESCE(NEW.mobile_money_number, ''), '\D', '', 'g'), 9)
       <> right(regexp_replace(COALESCE(a.mobile_money_number, ''), '\D', '', 'g'), 9) THEN
      v_unbacked := v_unbacked || 'mobile_money_number'::text;
    END IF;
  END IF;

  IF COALESCE(btrim(NEW.electricity_meter_number), '') <> COALESCE(btrim(OLD.electricity_meter_number), '') THEN
    v_changed := v_changed || 'electricity_meter_number'::text;
    IF COALESCE(btrim(NEW.electricity_meter_number), '') <> COALESCE(btrim(a.electricity_meter_number), '') THEN
      v_unbacked := v_unbacked || 'electricity_meter_number'::text;
    END IF;
  END IF;

  IF COALESCE(btrim(NEW.water_meter_number), '') <> COALESCE(btrim(OLD.water_meter_number), '') THEN
    v_changed := v_changed || 'water_meter_number'::text;
    IF COALESCE(btrim(NEW.water_meter_number), '') <> COALESCE(btrim(a.water_meter_number), '') THEN
      v_unbacked := v_unbacked || 'water_meter_number'::text;
    END IF;
  END IF;

  IF array_length(v_changed, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  IF array_length(v_unbacked, 1) IS NOT NULL THEN
    INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata)
    VALUES (v_actor, 'landlord_material_change_blocked', 'landlords', NEW.id,
      jsonb_build_object(
        'reason', 'Important landlord detail change blocked until a signed addendum or renewal is filed',
        'fields', to_jsonb(v_unbacked),
        'current_agreement_id', a.id,
        'current_agreement_no', a.agreement_no));

    RAISE EXCEPTION 'A signed addendum or renewal is required before changing: %. Upload the signed document first, then apply the change.',
      array_to_string(v_unbacked, ', ')
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata)
  VALUES (v_actor, 'landlord_material_change_applied', 'landlords', NEW.id,
    jsonb_build_object(
      'reason', 'Important landlord detail change applied, backed by the current signed agreement document',
      'fields', to_jsonb(v_changed),
      'agreement_id', a.id,
      'agreement_no', a.agreement_no,
      'agreement_kind', a.kind,
      'signed_file_path', a.signed_file_path));

  RETURN NEW;
END;
$function$;