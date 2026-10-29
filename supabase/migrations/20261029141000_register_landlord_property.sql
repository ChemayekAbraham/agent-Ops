-- Landlord "Register Property": one atomic server function instead of four browser writes.
--
-- The dialog used to insert the landlord record, then (separately, from the browser) the LC1
-- chairperson, the tenant's profile rent and a Welile Homes subscription. Database rules block the
-- last three for an ordinary landlord (tenants alone create their own subscription; only the owner,
-- an agent or a manager edits a profile; the LC1 rule needs registered_by, which was never set), and
-- the errors were ignored, so the landlord saw "Property registered!" while parts were lost. The
-- preferred payout day and the tenant's name were collected and never saved at all, the "already
-- registered" check could never fire (no unique key), and a tenant typed as 0783... never matched a
-- profile stored as +256783....
--
-- register_landlord_property validates, de-duplicates, links the tenant by normalised phone, saves
-- the LC1 contact and the landlord record in one transaction, and returns a reference number. The
-- Welile Homes subscription and the tenant's rent are no longer written here: the old browser code
-- could not create them for a landlord anyway, so nothing changes in practice, and they belong to
-- verification, not to a self-registration.
--
-- Verification evidence: at least ONE of meter number, GPS pin or a caretaker/LC1 contact is
-- required (previously a meter number was demanded, yet only 2 of 731 recent records have one).
ALTER TABLE public.landlords
  ADD COLUMN IF NOT EXISTS payout_day smallint,
  ADD COLUMN IF NOT EXISTS tenant_name text,
  ADD COLUMN IF NOT EXISTS tenant_phone text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'landlords_payout_day_check') THEN
    ALTER TABLE public.landlords
      ADD CONSTRAINT landlords_payout_day_check CHECK (payout_day IS NULL OR payout_day BETWEEN 1 AND 28);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.register_landlord_property(
  p_property_address text,
  p_ug_village_id integer,
  p_region text,
  p_district text,
  p_county text,
  p_subcounty text,
  p_village text,
  p_monthly_rent numeric,
  p_number_of_houses integer DEFAULT NULL,
  p_payout_day integer DEFAULT NULL,
  p_electricity_meter text DEFAULT NULL,
  p_water_meter text DEFAULT NULL,
  p_caretaker_name text DEFAULT NULL,
  p_caretaker_phone text DEFAULT NULL,
  p_latitude numeric DEFAULT NULL,
  p_longitude numeric DEFAULT NULL,
  p_property_status text DEFAULT 'empty',
  p_tenant_name text DEFAULT NULL,
  p_tenant_phone text DEFAULT NULL,
  p_lc1_name text DEFAULT NULL,
  p_lc1_phone text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_name text;
  v_phone text;
  v_address text := regexp_replace(btrim(COALESCE(p_property_address, '')), '\s+', ' ', 'g');
  v_meter_e text := NULLIF(btrim(COALESCE(p_electricity_meter, '')), '');
  v_meter_w text := NULLIF(btrim(COALESCE(p_water_meter, '')), '');
  v_care_name text := NULLIF(btrim(COALESCE(p_caretaker_name, '')), '');
  v_care_phone text := NULLIF(btrim(COALESCE(p_caretaker_phone, '')), '');
  v_lc1_name text := NULLIF(btrim(COALESCE(p_lc1_name, '')), '');
  v_lc1_phone text := NULLIF(btrim(COALESCE(p_lc1_phone, '')), '');
  v_tenant_name text := NULLIF(btrim(COALESCE(p_tenant_name, '')), '');
  v_tenant_phone text := NULLIF(btrim(COALESCE(p_tenant_phone, '')), '');
  v_tenant_last9 text;
  v_tenant_id uuid;
  v_lc1_last9 text;
  v_existing uuid;
  v_id uuid;
  v_has_gps boolean := p_latitude IS NOT NULL AND p_longitude IS NOT NULL;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  IF length(v_address) < 3 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'address_required');
  END IF;
  IF p_ug_village_id IS NULL OR NULLIF(btrim(COALESCE(p_district, '')), '') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'location_required');
  END IF;
  IF p_monthly_rent IS NULL OR p_monthly_rent <= 0 OR p_monthly_rent > 100000000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rent_invalid');
  END IF;
  IF p_number_of_houses IS NOT NULL AND (p_number_of_houses < 1 OR p_number_of_houses > 1000) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'houses_invalid');
  END IF;
  IF p_payout_day IS NOT NULL AND (p_payout_day < 1 OR p_payout_day > 28) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'payout_day_invalid');
  END IF;
  IF p_property_status NOT IN ('occupied', 'empty') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'status_invalid');
  END IF;
  IF p_property_status = 'occupied' AND v_tenant_phone IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'tenant_phone_required');
  END IF;
  -- One piece of evidence a manager can check: a meter number, a GPS pin, or a person to call.
  IF v_meter_e IS NULL AND v_meter_w IS NULL AND NOT v_has_gps
     AND v_care_phone IS NULL AND v_lc1_phone IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'proof_required');
  END IF;

  SELECT full_name, NULLIF(btrim(COALESCE(phone, '')), '')
    INTO v_name, v_phone
    FROM public.profiles WHERE id = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'profile_missing');
  END IF;
  IF v_phone IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'profile_phone_required');
  END IF;

  -- Same landlord + same address (ignoring case/spacing) is the same property.
  SELECT id INTO v_existing
    FROM public.landlords
   WHERE phone = v_phone
     AND lower(regexp_replace(btrim(property_address), '\s+', ' ', 'g')) = lower(regexp_replace(v_address, '\s+', ' ', 'g'))
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_registered', 'id', v_existing);
  END IF;

  -- Basic abuse guard: a landlord registering for themselves does not need dozens a day.
  IF (SELECT count(*) FROM public.landlords
       WHERE registered_by = v_uid AND created_at > now() - interval '24 hours') >= 15 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'too_many_registrations');
  END IF;

  -- Tenant: match an existing account by phone however it was typed (0783…, +256783…, 256783…).
  IF v_tenant_phone IS NOT NULL THEN
    v_tenant_last9 := right(regexp_replace(v_tenant_phone, '\D', '', 'g'), 9);
    IF length(v_tenant_last9) = 9 THEN
      SELECT id INTO v_tenant_id
        FROM public.profiles
       WHERE phone IN ('0' || v_tenant_last9, '+256' || v_tenant_last9, '256' || v_tenant_last9)
         AND id <> v_uid
       LIMIT 1;
    END IF;
  END IF;

  INSERT INTO public.landlords (
    tenant_id, name, phone, property_address,
    region, district, county, sub_county, village, ug_village_id, country,
    monthly_rent, desired_rent_from_welile, number_of_houses, payout_day,
    electricity_meter_number, water_meter_number,
    caretaker_name, caretaker_phone,
    latitude, longitude, location_captured_at, location_captured_by,
    registered_by, ready_to_receive, is_occupied, tenant_name, tenant_phone
  ) VALUES (
    v_tenant_id, COALESCE(NULLIF(btrim(COALESCE(v_name, '')), ''), 'Landlord'), v_phone, v_address,
    p_region, p_district, p_county, p_subcounty, p_village, p_ug_village_id, 'UG',
    p_monthly_rent, p_monthly_rent, p_number_of_houses, p_payout_day,
    v_meter_e, v_meter_w,
    v_care_name, v_care_phone,
    CASE WHEN v_has_gps THEN p_latitude END, CASE WHEN v_has_gps THEN p_longitude END,
    CASE WHEN v_has_gps THEN now() END, CASE WHEN v_has_gps THEN v_uid END,
    v_uid, false, p_property_status = 'occupied', v_tenant_name, v_tenant_phone
  ) RETURNING id INTO v_id;

  -- LC1 chairperson: a phone identifies one person, so reuse the record if it exists.
  IF v_lc1_name IS NOT NULL AND v_lc1_phone IS NOT NULL AND NULLIF(btrim(COALESCE(p_village, '')), '') IS NOT NULL THEN
    v_lc1_last9 := right(regexp_replace(v_lc1_phone, '\D', '', 'g'), 9);
    IF NOT EXISTS (
      SELECT 1 FROM public.lc1_chairpersons
       WHERE phone IN (v_lc1_phone, '0' || v_lc1_last9, '+256' || v_lc1_last9, '256' || v_lc1_last9)
    ) THEN
      INSERT INTO public.lc1_chairpersons (name, phone, village, registered_by)
      VALUES (v_lc1_name, v_lc1_phone, btrim(p_village), v_uid)
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_id,
    'reference', upper(left(replace(v_id::text, '-', ''), 8)),
    'tenant_linked', v_tenant_id IS NOT NULL
  );
END
$function$;

REVOKE ALL ON FUNCTION public.register_landlord_property(
  text, integer, text, text, text, text, text, numeric, integer, integer, text, text, text, text,
  numeric, numeric, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_landlord_property(
  text, integer, text, text, text, text, text, numeric, integer, integer, text, text, text, text,
  numeric, numeric, text, text, text, text, text) TO authenticated, service_role;
