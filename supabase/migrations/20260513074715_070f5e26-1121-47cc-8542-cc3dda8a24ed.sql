-- 1. Tracking columns
ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS returned_at timestamptz,
  ADD COLUMN IF NOT EXISTS resubmission_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_resubmitted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_rent_requests_returned_at
  ON public.rent_requests (returned_at DESC)
  WHERE status = 'rejected';

-- 2. Centralized return-for-correction RPC
CREATE OR REPLACE FUNCTION public.return_rent_request_for_correction(
  p_request_id uuid,
  p_stage text,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.rent_requests%ROWTYPE;
  _uid uuid := auth.uid();
  _allowed_stages text[] := ARRAY[
    'pending','agent_ops_approved','tenant_ops_approved',
    'landlord_ops_approved','coo_approved','cfo_approved','approved'
  ];
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Rejection reason must be at least 10 characters';
  END IF;

  IF NOT (p_stage = ANY(_allowed_stages)) THEN
    RAISE EXCEPTION 'Invalid stage: %', p_stage;
  END IF;

  IF NOT (
    has_role(_uid, 'tenant_ops'::app_role)
    OR has_role(_uid, 'landlord_ops'::app_role)
    OR has_role(_uid, 'coo'::app_role)
    OR has_role(_uid, 'cfo'::app_role)
    OR has_role(_uid, 'manager'::app_role)
    OR has_role(_uid, 'agent_ops'::app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized to return rent requests for correction';
  END IF;

  SELECT * INTO _row FROM public.rent_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rent request not found';
  END IF;

  IF _row.status IN ('rejected','funded','disbursed','cancelled') THEN
    RAISE EXCEPTION 'Cannot return request in status: %', _row.status;
  END IF;

  UPDATE public.rent_requests
     SET status            = 'rejected',
         rejected_reason   = trim(p_reason),
         rejected_at_stage = p_stage,
         rejected_at       = now(),
         returned_at       = now(),
         reopen_count      = COALESCE(reopen_count, 0) + 1,
         updated_at        = now()
   WHERE id = p_request_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
  VALUES (
    'rent_request_returned_for_correction',
    'rent_requests',
    p_request_id,
    _uid,
    jsonb_build_object(
      'rejected_at_stage', p_stage,
      'reason', trim(p_reason),
      'previous_status', _row.status
    )
  );

  INSERT INTO public.system_events
    (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'rent_request.returned_for_correction',
    _uid,
    'rent_request',
    p_request_id,
    jsonb_build_object(
      'rejected_at_stage', p_stage,
      'reason', trim(p_reason)
    )
  );

  RETURN p_request_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.return_rent_request_for_correction(uuid, text, text) TO authenticated;

-- 3. Patch agent_resubmit_rent_request to bump new counters
CREATE OR REPLACE FUNCTION public.agent_resubmit_rent_request(p_request_id uuid, p_patch jsonb, p_agent_note text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _row public.rent_requests%ROWTYPE;
  _new_rent numeric;
  _new_duration int;
  _new_payments int;
  _new_water text;
  _new_elec text;
  _new_lat double precision;
  _new_lng double precision;
  _new_house_category text;
  _new_pref_lang text;
  _new_no_smartphone boolean;
  _new_landlord uuid;
  _new_lc1 uuid;
  _new_outstanding numeric;
  _new_grace int;
  _access_fee_rate numeric := 0.33;
  _access_fee numeric;
  _request_fee numeric := 0;
  _total numeric;
  _daily numeric;
  _next_status text;
BEGIN
  IF p_agent_note IS NULL OR length(trim(p_agent_note)) < 10 THEN
    RAISE EXCEPTION 'Resubmission note must be at least 10 characters';
  END IF;

  SELECT * INTO _row FROM public.rent_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rent request not found';
  END IF;

  IF _row.agent_id IS NULL OR _row.agent_id <> auth.uid() THEN
    RAISE EXCEPTION 'Only the agent who created this request can resubmit it';
  END IF;

  IF _row.status <> 'rejected' THEN
    RAISE EXCEPTION 'Only rejected requests can be resubmitted (current status: %)', _row.status;
  END IF;

  IF COALESCE(_row.reopen_count, 0) >= 3 THEN
    RAISE EXCEPTION 'Reopen limit reached (3). Contact a manager to reopen further.';
  END IF;

  _new_rent     := COALESCE((p_patch->>'rent_amount')::numeric,        _row.rent_amount);
  _new_duration := COALESCE((p_patch->>'duration_days')::int,          _row.duration_days);
  _new_payments := COALESCE((p_patch->>'number_of_payments')::int,     COALESCE(_row.number_of_payments, 4));
  _new_water    := COALESCE(p_patch->>'tenant_water_meter',            _row.tenant_water_meter);
  _new_elec     := COALESCE(p_patch->>'tenant_electricity_meter',      _row.tenant_electricity_meter);
  _new_lat      := COALESCE((p_patch->>'request_latitude')::double precision,  _row.request_latitude);
  _new_lng      := COALESCE((p_patch->>'request_longitude')::double precision, _row.request_longitude);

  _new_house_category := COALESCE(p_patch->>'house_category',          _row.house_category);
  _new_pref_lang      := COALESCE(p_patch->>'preferred_language',      _row.preferred_language);
  _new_no_smartphone  := COALESCE((p_patch->>'tenant_no_smartphone')::boolean, _row.tenant_no_smartphone);
  _new_landlord       := COALESCE((p_patch->>'landlord_id')::uuid,     _row.landlord_id);
  IF p_patch ? 'lc1_id' THEN
    _new_lc1 := NULLIF(p_patch->>'lc1_id','')::uuid;
  ELSE
    _new_lc1 := _row.lc1_id;
  END IF;
  _new_outstanding := COALESCE((p_patch->>'initial_outstanding_balance')::numeric, _row.initial_outstanding_balance);
  IF p_patch ? 'outstanding_grace_days' THEN
    _new_grace := NULLIF(p_patch->>'outstanding_grace_days','')::int;
  ELSE
    _new_grace := _row.outstanding_grace_days;
  END IF;

  IF _new_rent IS NULL OR _new_rent <= 0 THEN
    RAISE EXCEPTION 'Invalid rent amount';
  END IF;
  IF _new_duration < 7 OR _new_duration > 120 THEN
    RAISE EXCEPTION 'Duration must be between 7 and 120 days';
  END IF;
  IF _new_payments < 1 OR _new_payments > _new_duration THEN
    RAISE EXCEPTION 'Invalid number of payments';
  END IF;

  _access_fee := round(_new_rent * _access_fee_rate);
  _total      := _new_rent + _access_fee + _request_fee;
  _daily      := round(_total / _new_duration);

  _next_status := COALESCE(_row.rejected_at_stage, 'pending');

  UPDATE public.rent_requests
     SET rent_amount               = _new_rent,
         duration_days             = _new_duration,
         number_of_payments        = _new_payments,
         access_fee                = _access_fee,
         request_fee               = _request_fee,
         total_repayment           = _total,
         daily_repayment           = _daily,
         tenant_water_meter        = _new_water,
         tenant_electricity_meter  = _new_elec,
         request_latitude          = _new_lat,
         request_longitude         = _new_lng,
         house_category            = _new_house_category,
         preferred_language        = _new_pref_lang,
         tenant_no_smartphone      = COALESCE(_new_no_smartphone, false),
         landlord_id               = _new_landlord,
         lc1_id                    = _new_lc1,
         initial_outstanding_balance = _new_outstanding,
         outstanding_grace_days    = _new_grace,
         status                    = _next_status,
         rejected_at               = NULL,
         rejected_reason           = NULL,
         rejected_at_stage         = NULL,
         reopen_count              = COALESCE(_row.reopen_count, 0) + 1,
         resubmission_count        = COALESCE(_row.resubmission_count, 0) + 1,
         last_resubmitted_at       = now(),
         resubmitted_at            = now(),
         resubmitted_note          = trim(p_agent_note),
         updated_at                = now()
   WHERE id = p_request_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
  VALUES (
    'rent_request_resubmitted_by_agent',
    'rent_requests',
    p_request_id,
    auth.uid(),
    jsonb_build_object(
      'reason', trim(p_agent_note),
      'returned_to_status', _next_status,
      'reopen_count', COALESCE(_row.reopen_count, 0) + 1,
      'resubmission_count', COALESCE(_row.resubmission_count, 0) + 1,
      'previous_rejected_reason', _row.rejected_reason,
      'previous_rejected_at_stage', _row.rejected_at_stage,
      'patch', p_patch
    )
  );

  INSERT INTO public.system_events
    (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'rent_request.resubmitted_by_agent',
    auth.uid(),
    'rent_request',
    p_request_id,
    jsonb_build_object(
      'returned_to_status', _next_status,
      'reopen_count', COALESCE(_row.reopen_count, 0) + 1,
      'resubmission_count', COALESCE(_row.resubmission_count, 0) + 1
    )
  );

  RETURN p_request_id;
END;
$function$;