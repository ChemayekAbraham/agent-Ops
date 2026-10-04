CREATE OR REPLACE FUNCTION public.agent_resubmit_rent_request(p_request_id uuid, p_patch jsonb, p_agent_note text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _row public.rent_requests%ROWTYPE;
  _new_rent numeric; _new_duration int; _new_payments int;
  _new_water text; _new_elec text;
  _new_lat double precision; _new_lng double precision;
  _new_house_category text; _new_pref_lang text;
  _new_no_smartphone boolean; _new_landlord uuid; _new_lc1 uuid;
  _new_landlord_name text; _new_landlord_phone text; _new_landlord_address text;
  _new_outstanding numeric; _new_grace int;
  _new_house_images text[]; _new_lc_path text; _new_lc_bucket text;
  _access_fee_rate numeric := 0.33;
  _principal numeric; _access_fee numeric; _request_fee numeric := 0;
  _total numeric; _daily numeric; _next_status text; _is_outstanding boolean;
  _resubmit_cap int := 5;
BEGIN
  IF p_agent_note IS NULL OR length(trim(p_agent_note)) < 10 THEN
    RAISE EXCEPTION 'Resubmission note must be at least 10 characters';
  END IF;

  SELECT * INTO _row FROM public.rent_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rent request not found'; END IF;
  IF _row.agent_id IS NULL OR _row.agent_id <> auth.uid() THEN
    RAISE EXCEPTION 'Only the agent who created this request can resubmit it';
  END IF;
  IF _row.status <> 'rejected' THEN
    RAISE EXCEPTION 'Only rejected requests can be resubmitted (current status: %)', _row.status;
  END IF;
  IF COALESCE(_row.reopen_count, 0) >= _resubmit_cap THEN
    RAISE EXCEPTION 'Reopen limit reached (%). Contact a manager to reopen further.', _resubmit_cap;
  END IF;

  _new_rent     := COALESCE((p_patch->>'rent_amount')::numeric, _row.rent_amount);
  _new_duration := COALESCE((p_patch->>'duration_days')::int, _row.duration_days);
  _new_payments := COALESCE((p_patch->>'number_of_payments')::int, COALESCE(_row.number_of_payments, 4));
  _new_water    := COALESCE(p_patch->>'tenant_water_meter', _row.tenant_water_meter);
  _new_elec     := COALESCE(p_patch->>'tenant_electricity_meter', _row.tenant_electricity_meter);
  _new_lat      := COALESCE((p_patch->>'request_latitude')::double precision, _row.request_latitude);
  _new_lng      := COALESCE((p_patch->>'request_longitude')::double precision, _row.request_longitude);
  _new_house_category := COALESCE(p_patch->>'house_category', _row.house_category);
  _new_pref_lang      := COALESCE(p_patch->>'preferred_language', _row.preferred_language);
  _new_no_smartphone  := COALESCE((p_patch->>'tenant_no_smartphone')::boolean, _row.tenant_no_smartphone);
  _new_landlord       := COALESCE((p_patch->>'landlord_id')::uuid, _row.landlord_id);
  _new_landlord_name  := NULLIF(trim(COALESCE(p_patch->>'landlord_name', '')), '');
  _new_landlord_phone := NULLIF(trim(COALESCE(p_patch->>'landlord_phone', '')), '');
  _new_landlord_address := NULLIF(trim(COALESCE(p_patch->>'landlord_address', '')), '');
  IF p_patch ? 'lc1_id' THEN _new_lc1 := NULLIF(p_patch->>'lc1_id','')::uuid; ELSE _new_lc1 := _row.lc1_id; END IF;
  _new_outstanding := COALESCE((p_patch->>'initial_outstanding_balance')::numeric, _row.initial_outstanding_balance);
  IF p_patch ? 'outstanding_grace_days' THEN _new_grace := NULLIF(p_patch->>'outstanding_grace_days','')::int; ELSE _new_grace := _row.outstanding_grace_days; END IF;

  -- Evidence corrections: house photos + LC letter. A reviewer often rejects
  -- because the photos are unusable or the LC letter is missing, so the agent
  -- must be able to replace them here. An empty array is IGNORED so a bad
  -- client can never wipe existing evidence.
  IF p_patch ? 'house_image_urls' THEN
    IF jsonb_typeof(p_patch->'house_image_urls') <> 'array' THEN
      RAISE EXCEPTION 'house_image_urls must be an array of image URLs';
    END IF;
    SELECT array_agg(v) INTO _new_house_images
      FROM jsonb_array_elements_text(p_patch->'house_image_urls') AS t(v)
     WHERE NULLIF(trim(v), '') IS NOT NULL;
  END IF;
  _new_house_images := COALESCE(_new_house_images, _row.house_image_urls);

  IF p_patch ? 'lc_letter_path' THEN
    _new_lc_path   := NULLIF(trim(COALESCE(p_patch->>'lc_letter_path','')), '');
    _new_lc_bucket := COALESCE(NULLIF(trim(COALESCE(p_patch->>'lc_letter_bucket','')), ''), 'lc-letters');
  END IF;
  _new_lc_path   := COALESCE(_new_lc_path, _row.lc_letter_path);
  _new_lc_bucket := COALESCE(_new_lc_bucket, _row.lc_letter_bucket);

  IF _new_rent IS NULL OR _new_rent <= 0 THEN RAISE EXCEPTION 'Invalid rent amount'; END IF;
  IF _new_duration NOT IN (7, 14, 21, 30, 60, 90, 120) THEN RAISE EXCEPTION 'Duration must be one of 7, 14, 21, 30, 60, 90, or 120 days'; END IF;
  IF _new_payments < 1 OR _new_payments > _new_duration THEN RAISE EXCEPTION 'Invalid number of payments'; END IF;
  IF _new_landlord IS NULL THEN RAISE EXCEPTION 'Landlord is required'; END IF;

  IF (_new_landlord_name IS NOT NULL OR _new_landlord_phone IS NOT NULL OR _new_landlord_address IS NOT NULL) THEN
    UPDATE public.landlords
       SET name = COALESCE(_new_landlord_name, name),
           phone = COALESCE(_new_landlord_phone, phone),
           property_address = COALESCE(_new_landlord_address, property_address),
           updated_at = now()
     WHERE id = _new_landlord
       AND (
         _new_landlord = _row.landlord_id
         OR managed_by_agent_id = auth.uid()
         OR registered_by = auth.uid()
       );
  END IF;

  _is_outstanding := (_row.registration_type = 'outstanding_balance');
  _principal := CASE WHEN _is_outstanding THEN COALESCE(NULLIF(_new_outstanding, 0), _new_rent) ELSE _new_rent END;

  IF _is_outstanding THEN
    _access_fee  := round(_principal * (power(1 + _access_fee_rate, _new_duration::numeric / 30.0) - 1));
    _request_fee := CASE WHEN _principal <= 200000 THEN 10000 ELSE 20000 END;
    _total       := _principal + _access_fee + _request_fee;
    _daily       := ceil(_total / _new_duration);
  ELSE
    _access_fee := round(_principal * _access_fee_rate);
    _total      := _principal + _access_fee + _request_fee;
    _daily      := round(_total / _new_duration);
  END IF;

  _next_status := COALESCE(_row.rejected_at_stage, 'pending');

  UPDATE public.rent_requests
     SET rent_amount = _new_rent, duration_days = _new_duration, number_of_payments = _new_payments,
         access_fee = _access_fee, request_fee = _request_fee,
         total_repayment = _total, daily_repayment = _daily,
         tenant_water_meter = _new_water, tenant_electricity_meter = _new_elec,
         request_latitude = _new_lat, request_longitude = _new_lng,
         house_category = _new_house_category, preferred_language = _new_pref_lang,
         tenant_no_smartphone = COALESCE(_new_no_smartphone, false),
         landlord_id = _new_landlord, lc1_id = _new_lc1,
         house_image_urls = _new_house_images,
         lc_letter_path = _new_lc_path, lc_letter_bucket = _new_lc_bucket,
         initial_outstanding_balance = _new_outstanding, outstanding_grace_days = _new_grace,
         status = _next_status, rejected_at = NULL, rejected_reason = NULL, rejected_at_stage = NULL,
         reopen_count = COALESCE(_row.reopen_count, 0) + 1,
         resubmission_count = COALESCE(_row.resubmission_count, 0) + 1,
         last_resubmitted_at = now(), resubmitted_at = now(),
         resubmitted_note = trim(p_agent_note), updated_at = now()
   WHERE id = p_request_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
  VALUES ('rent_request_resubmitted_by_agent','rent_requests',p_request_id,auth.uid(),
    jsonb_build_object('reason', trim(p_agent_note),'returned_to_status', _next_status,
      'reopen_count', COALESCE(_row.reopen_count,0)+1,'resubmission_count', COALESCE(_row.resubmission_count,0)+1,
      'previous_rejected_reason', _row.rejected_reason,'previous_rejected_at_stage', _row.rejected_at_stage,
      'patch', p_patch,'recomputed_total_repayment', _total,'recomputed_daily_repayment', _daily,
      'principal_used', _principal,'is_outstanding', _is_outstanding,
      'house_photo_count', COALESCE(array_length(_new_house_images, 1), 0),
      'house_photos_changed', (_new_house_images IS DISTINCT FROM _row.house_image_urls),
      'lc_letter_changed', (_new_lc_path IS DISTINCT FROM _row.lc_letter_path),
      'resubmit_cap', _resubmit_cap));

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES ('rent_request.resubmitted_by_agent', auth.uid(),'rent_request', p_request_id,
    jsonb_build_object('returned_to_status', _next_status,
      'reopen_count', COALESCE(_row.reopen_count,0)+1,
      'resubmission_count', COALESCE(_row.reopen_count,0)+1));

  RETURN p_request_id;
END;
$function$;