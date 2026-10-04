CREATE OR REPLACE FUNCTION public.submit_landlord_agreement(
  p_landlord_id uuid,
  p_kind text,
  p_file_path text,
  p_file_name text,
  p_file_sha256 text,
  p_file_mime_type text,
  p_details jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_version_id uuid;
  v_current_id uuid;
  v_sequence integer;
  v_id uuid;
  v_agreement_no text;
  v_start date;
  v_end date;
  v_agreement_date date;
BEGIN
  IF v_actor IS NULL OR NOT public.landlord_agreement_actor_can_view(p_landlord_id) THEN
    RAISE EXCEPTION 'Not authorized to submit this landlord agreement' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('original','addendum','renewal','termination') THEN
    RAISE EXCEPTION 'Invalid landlord agreement type';
  END IF;
  IF p_file_path IS NULL OR p_file_path = '' OR position(p_landlord_id::text || '/' IN p_file_path) <> 1 THEN
    RAISE EXCEPTION 'Agreement file must be stored under the landlord agreement folder';
  END IF;
  IF p_details IS NULL THEN
    RAISE EXCEPTION 'Agreement details are required';
  END IF;

  v_agreement_date := NULLIF(p_details->>'agreement_date', '')::date;
  v_start := NULLIF(p_details->>'start_date', '')::date;
  v_end := NULLIF(p_details->>'end_date', '')::date;
  IF v_agreement_date IS NULL OR v_start IS NULL OR v_end IS NULL OR v_end < v_start THEN
    RAISE EXCEPTION 'Agreement date, start date, and valid end date are required';
  END IF;
  IF NULLIF(btrim(p_details->>'property_address'), '') IS NULL
     OR NULLIF(btrim(p_details->>'landlord_name'), '') IS NULL
     OR NULLIF(btrim(p_details->>'landlord_phone'), '') IS NULL
     OR NULLIF(btrim(p_details->>'monthly_rent'), '') IS NULL
     OR NULLIF(btrim(p_details->>'payment_day'), '') IS NULL THEN
    RAISE EXCEPTION 'Identity, property, rent, and payment terms are required';
  END IF;
  IF NULLIF(btrim(p_details->>'landlord_signature_name'), '') IS NULL
     OR NULLIF(btrim(p_details->>'welile_signature_name'), '') IS NULL
     OR NULLIF(btrim(p_details->>'witness_name'), '') IS NULL THEN
    RAISE EXCEPTION 'Landlord, Welile, and witness names are required';
  END IF;

  SELECT id INTO v_version_id
  FROM public.landlord_agreement_versions
  WHERE retired_at IS NULL
  ORDER BY effective_from DESC, created_at DESC
  LIMIT 1;
  IF v_version_id IS NULL THEN
    RAISE EXCEPTION 'No active landlord agreement template is configured';
  END IF;

  SELECT id INTO v_current_id
  FROM public.landlord_agreements
  WHERE landlord_id = p_landlord_id AND is_current = true
  LIMIT 1;

  SELECT COALESCE(max(sequence_no), 0) + 1 INTO v_sequence
  FROM public.landlord_agreements
  WHERE landlord_id = p_landlord_id;
  v_agreement_no := 'LL-' || to_char(current_date, 'YYYYMMDD') || '-' || lpad(v_sequence::text, 4, '0');

  INSERT INTO public.landlord_agreements (
    landlord_id, version_id, agreement_no, sequence_no, kind, status, is_current, supersedes_id,
    agreement_date, start_date, end_date, landlord_name, landlord_phone, nin, property_address,
    house_number, house_category, monthly_rent, payment_day, payout_mode,
    bank_name, account_number, mobile_money_name, mobile_money_number, water_meter_number,
    water_registered_name, electricity_meter_number, electricity_registered_name,
    landlord_signature_name, landlord_signature_path, landlord_signed_on,
    welile_signature_name, welile_signature_path, welile_signed_on,
    witness_name, witness_signature_path, witness_signed_on,
    signed_file_path, signed_file_name, signed_file_sha256, signed_file_mime_type,
    uploaded_by, termination_notice_date, termination_effective_date, termination_party, metadata
  ) VALUES (
    p_landlord_id, v_version_id, v_agreement_no, v_sequence, p_kind, 'active', p_kind <> 'termination', v_current_id,
    v_agreement_date, v_start, v_end, btrim(p_details->>'landlord_name'), btrim(p_details->>'landlord_phone'),
    NULLIF(btrim(p_details->>'nin'), ''), btrim(p_details->>'property_address'), NULLIF(btrim(p_details->>'house_number'), ''),
    NULLIF(btrim(p_details->>'house_category'), ''), (p_details->>'monthly_rent')::numeric, (p_details->>'payment_day')::integer,
    NULLIF(btrim(p_details->>'payout_mode'), ''), NULLIF(btrim(p_details->>'bank_name'), ''), NULLIF(btrim(p_details->>'account_number'), ''),
    NULLIF(btrim(p_details->>'mobile_money_name'), ''), NULLIF(btrim(p_details->>'mobile_money_number'), ''),
    NULLIF(btrim(p_details->>'water_meter_number'), ''), NULLIF(btrim(p_details->>'water_registered_name'), ''),
    NULLIF(btrim(p_details->>'electricity_meter_number'), ''), NULLIF(btrim(p_details->>'electricity_registered_name'), ''),
    btrim(p_details->>'landlord_signature_name'), p_file_path, NULLIF(p_details->>'landlord_signed_on', '')::date,
    btrim(p_details->>'welile_signature_name'), p_file_path, NULLIF(p_details->>'welile_signed_on', '')::date,
    btrim(p_details->>'witness_name'), p_file_path, NULLIF(p_details->>'witness_signed_on', '')::date,
    p_file_path, NULLIF(btrim(p_file_name), ''), NULLIF(btrim(p_file_sha256), ''), NULLIF(btrim(p_file_mime_type), ''),
    v_actor, NULLIF(p_details->>'termination_notice_date', '')::date,
    NULLIF(p_details->>'termination_effective_date', '')::date,
    NULLIF(btrim(p_details->>'termination_party'), ''), p_details
  ) RETURNING id INTO v_id;

  INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata)
  VALUES (v_actor, 'landlord_agreement_submitted', 'landlord_agreements', v_id,
    jsonb_build_object('reason', 'Submitted signed landlord agreement for immutable record history',
      'landlord_id', p_landlord_id, 'kind', p_kind, 'agreement_no', v_agreement_no,
      'supersedes_id', v_current_id));

  RETURN jsonb_build_object('ok', true, 'agreement_id', v_id, 'agreement_no', v_agreement_no,
    'landlord_id', p_landlord_id, 'kind', p_kind);
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_landlord_agreement(uuid, text, text, text, text, text, jsonb) TO authenticated;