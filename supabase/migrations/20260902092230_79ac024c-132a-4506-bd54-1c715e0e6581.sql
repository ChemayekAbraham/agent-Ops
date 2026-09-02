-- Tier-1 landlord detail changes require a signed addendum/renewal first.
CREATE OR REPLACE FUNCTION public.guard_landlord_agreement_backed_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- No agreement regime yet (e.g. legacy landlords): leave behaviour untouched.
  IF a.id IS NULL THEN
    RETURN NEW;
  END IF;

  -- name
  IF COALESCE(btrim(NEW.name), '') <> COALESCE(btrim(OLD.name), '') THEN
    v_changed := v_changed || 'name';
    IF lower(COALESCE(btrim(NEW.name), '')) <> lower(COALESCE(btrim(a.landlord_name), '')) THEN
      v_unbacked := v_unbacked || 'name';
    END IF;
  END IF;

  IF COALESCE(btrim(NEW.phone), '') <> COALESCE(btrim(OLD.phone), '') THEN
    v_changed := v_changed || 'phone';
    IF right(regexp_replace(COALESCE(NEW.phone, ''), '\D', '', 'g'), 9)
       <> right(regexp_replace(COALESCE(a.landlord_phone, ''), '\D', '', 'g'), 9) THEN
      v_unbacked := v_unbacked || 'phone';
    END IF;
  END IF;

  IF COALESCE(btrim(NEW.property_address), '') <> COALESCE(btrim(OLD.property_address), '') THEN
    v_changed := v_changed || 'property_address';
    IF lower(COALESCE(btrim(NEW.property_address), '')) <> lower(COALESCE(btrim(a.property_address), '')) THEN
      v_unbacked := v_unbacked || 'property_address';
    END IF;
  END IF;

  IF COALESCE(btrim(NEW.house_number), '') <> COALESCE(btrim(OLD.house_number), '') THEN
    v_changed := v_changed || 'house_number';
    IF lower(COALESCE(btrim(NEW.house_number), '')) <> lower(COALESCE(btrim(a.house_number), '')) THEN
      v_unbacked := v_unbacked || 'house_number';
    END IF;
  END IF;

  IF COALESCE(btrim(NEW.house_category), '') <> COALESCE(btrim(OLD.house_category), '') THEN
    v_changed := v_changed || 'house_category';
    IF lower(COALESCE(btrim(NEW.house_category), '')) <> lower(COALESCE(btrim(a.house_category), '')) THEN
      v_unbacked := v_unbacked || 'house_category';
    END IF;
  END IF;

  IF COALESCE(NEW.number_of_rooms, -1) <> COALESCE(OLD.number_of_rooms, -1) THEN
    v_changed := v_changed || 'number_of_rooms';
    IF COALESCE(NEW.number_of_rooms, -1) <> COALESCE(a.number_of_rooms, -1) THEN
      v_unbacked := v_unbacked || 'number_of_rooms';
    END IF;
  END IF;

  IF COALESCE(NEW.monthly_rent, -1) <> COALESCE(OLD.monthly_rent, -1) THEN
    v_changed := v_changed || 'monthly_rent';
    IF COALESCE(NEW.monthly_rent, -1) <> COALESCE(a.monthly_rent, -1) THEN
      v_unbacked := v_unbacked || 'monthly_rent';
    END IF;
  END IF;

  IF COALESCE(btrim(NEW.bank_name), '') <> COALESCE(btrim(OLD.bank_name), '') THEN
    v_changed := v_changed || 'bank_name';
    IF lower(COALESCE(btrim(NEW.bank_name), '')) <> lower(COALESCE(btrim(a.bank_name), '')) THEN
      v_unbacked := v_unbacked || 'bank_name';
    END IF;
  END IF;

  IF COALESCE(btrim(NEW.account_number), '') <> COALESCE(btrim(OLD.account_number), '') THEN
    v_changed := v_changed || 'account_number';
    IF COALESCE(btrim(NEW.account_number), '') <> COALESCE(btrim(a.account_number), '') THEN
      v_unbacked := v_unbacked || 'account_number';
    END IF;
  END IF;

  IF COALESCE(btrim(NEW.mobile_money_name), '') <> COALESCE(btrim(OLD.mobile_money_name), '') THEN
    v_changed := v_changed || 'mobile_money_name';
    IF lower(COALESCE(btrim(NEW.mobile_money_name), '')) <> lower(COALESCE(btrim(a.mobile_money_name), '')) THEN
      v_unbacked := v_unbacked || 'mobile_money_name';
    END IF;
  END IF;

  IF COALESCE(btrim(NEW.mobile_money_number), '') <> COALESCE(btrim(OLD.mobile_money_number), '') THEN
    v_changed := v_changed || 'mobile_money_number';
    IF right(regexp_replace(COALESCE(NEW.mobile_money_number, ''), '\D', '', 'g'), 9)
       <> right(regexp_replace(COALESCE(a.mobile_money_number, ''), '\D', '', 'g'), 9) THEN
      v_unbacked := v_unbacked || 'mobile_money_number';
    END IF;
  END IF;

  IF COALESCE(btrim(NEW.electricity_meter_number), '') <> COALESCE(btrim(OLD.electricity_meter_number), '') THEN
    v_changed := v_changed || 'electricity_meter_number';
    IF COALESCE(btrim(NEW.electricity_meter_number), '') <> COALESCE(btrim(a.electricity_meter_number), '') THEN
      v_unbacked := v_unbacked || 'electricity_meter_number';
    END IF;
  END IF;

  IF COALESCE(btrim(NEW.water_meter_number), '') <> COALESCE(btrim(OLD.water_meter_number), '') THEN
    v_changed := v_changed || 'water_meter_number';
    IF COALESCE(btrim(NEW.water_meter_number), '') <> COALESCE(btrim(a.water_meter_number), '') THEN
      v_unbacked := v_unbacked || 'water_meter_number';
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
$$;

DROP TRIGGER IF EXISTS trg_guard_landlord_agreement_backed_changes ON public.landlords;
CREATE TRIGGER trg_guard_landlord_agreement_backed_changes
  BEFORE UPDATE ON public.landlords
  FOR EACH ROW EXECUTE FUNCTION public.guard_landlord_agreement_backed_changes();

-- Read helper so any landlord view can show the full agreement trail.
CREATE OR REPLACE FUNCTION public.landlord_agreement_history(p_landlord_id uuid)
RETURNS TABLE (
  id uuid,
  agreement_no text,
  sequence_no integer,
  kind text,
  status text,
  is_current boolean,
  agreement_date date,
  start_date date,
  end_date date,
  landlord_name text,
  landlord_phone text,
  nin text,
  property_address text,
  house_number text,
  house_category text,
  number_of_rooms integer,
  monthly_rent numeric,
  payment_day integer,
  payout_mode text,
  bank_name text,
  account_number text,
  mobile_money_name text,
  mobile_money_number text,
  water_meter_number text,
  electricity_meter_number text,
  landlord_signature_name text,
  landlord_signed_on date,
  welile_signature_name text,
  welile_signed_on date,
  witness_name text,
  witness_signed_on date,
  signed_file_path text,
  signed_file_name text,
  bucket text,
  uploaded_by uuid,
  uploaded_by_name text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id, a.agreement_no, a.sequence_no, a.kind, a.status, a.is_current,
         a.agreement_date, a.start_date, a.end_date, a.landlord_name, a.landlord_phone,
         a.nin, a.property_address, a.house_number, a.house_category, a.number_of_rooms,
         a.monthly_rent, a.payment_day, a.payout_mode, a.bank_name, a.account_number,
         a.mobile_money_name, a.mobile_money_number, a.water_meter_number,
         a.electricity_meter_number, a.landlord_signature_name, a.landlord_signed_on,
         a.welile_signature_name, a.welile_signed_on, a.witness_name, a.witness_signed_on,
         a.signed_file_path, a.signed_file_name, a.bucket, a.uploaded_by,
         p.full_name, a.created_at
  FROM public.landlord_agreements a
  LEFT JOIN public.profiles p ON p.id = a.uploaded_by
  WHERE a.landlord_id = p_landlord_id
    AND public.landlord_agreement_actor_can_view(p_landlord_id)
  ORDER BY a.sequence_no DESC;
$$;

GRANT EXECUTE ON FUNCTION public.landlord_agreement_history(uuid) TO authenticated;