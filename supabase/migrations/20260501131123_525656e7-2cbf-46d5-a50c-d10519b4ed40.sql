
-- =====================================================================
-- Agent: edit-and-resubmit + delete for rejected rent requests
-- =====================================================================

-- RLS: let an agent UPDATE their own rejected rent request
-- (the SECURITY DEFINER RPC below is the primary path; this is defence-in-depth
--  and unblocks the RPC's UPDATE under strict mode).
DROP POLICY IF EXISTS "Agents can edit own rejected requests" ON public.rent_requests;
CREATE POLICY "Agents can edit own rejected requests"
ON public.rent_requests
FOR UPDATE
USING (
  public.has_role(auth.uid(), 'agent'::app_role)
  AND agent_id = auth.uid()
  AND status IN ('rejected','deleted_by_agent')
)
WITH CHECK (
  public.has_role(auth.uid(), 'agent'::app_role)
  AND agent_id = auth.uid()
);

-- ---------------------------------------------------------------------
-- RPC: agent_resubmit_rent_request
-- Whitelisted patch + recompute fees + regen schedule + reopen semantics.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_resubmit_rent_request(
  p_request_id uuid,
  p_patch jsonb,
  p_agent_note text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.rent_requests%ROWTYPE;
  _new_rent numeric;
  _new_duration int;
  _new_payments int;
  _new_water text;
  _new_elec text;
  _new_lat double precision;
  _new_lng double precision;
  _access_fee_rate numeric := 0.33;
  _access_fee numeric;
  _request_fee numeric := 0;
  _total numeric;
  _daily numeric;
  _days_between int;
  _per_payment numeric;
  _remainder numeric;
  _i int;
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

  -- Whitelisted patch fields
  _new_rent     := COALESCE((p_patch->>'rent_amount')::numeric,        _row.rent_amount);
  _new_duration := COALESCE((p_patch->>'duration_days')::int,          _row.duration_days);
  _new_payments := COALESCE((p_patch->>'number_of_payments')::int,     COALESCE(_row.number_of_payments, 4));
  _new_water    := COALESCE(p_patch->>'tenant_water_meter',            _row.tenant_water_meter);
  _new_elec     := COALESCE(p_patch->>'tenant_electricity_meter',      _row.tenant_electricity_meter);
  _new_lat      := COALESCE((p_patch->>'request_latitude')::double precision,  _row.request_latitude);
  _new_lng      := COALESCE((p_patch->>'request_longitude')::double precision, _row.request_longitude);

  IF _new_rent IS NULL OR _new_rent <= 0 THEN
    RAISE EXCEPTION 'Invalid rent amount';
  END IF;
  IF _new_duration < 7 OR _new_duration > 120 THEN
    RAISE EXCEPTION 'Duration must be between 7 and 120 days';
  END IF;
  IF _new_payments < 1 OR _new_payments > _new_duration THEN
    RAISE EXCEPTION 'Invalid number of payments';
  END IF;

  -- Recompute fees (mirrors src/lib/rentCalculations behaviour)
  _access_fee  := round(_new_rent * _access_fee_rate);
  _request_fee := COALESCE(_row.request_fee, 0);
  _total       := _new_rent + _access_fee + _request_fee;
  _daily       := round(_total / _new_duration);

  -- Status returns to the stage that rejected it (mirrors reopen_rent_request)
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
         status                    = _next_status,
         rejected_reason           = NULL,
         rejected_at               = NULL,
         rejected_at_stage         = NULL,
         reopened_at               = now(),
         reopened_by               = auth.uid(),
         reopen_count              = COALESCE(_row.reopen_count, 0) + 1,
         reopen_reason             = trim(p_agent_note),
         updated_at                = now()
   WHERE id = p_request_id;

  -- Regenerate repayment schedule
  DELETE FROM public.repayment_schedules WHERE rent_request_id = p_request_id;

  _days_between := GREATEST(floor(_new_duration::numeric / _new_payments)::int, 1);
  _per_payment  := ceil(_total::numeric / _new_payments);
  _remainder    := _total - (_per_payment * (_new_payments - 1));

  FOR _i IN 1.._new_payments LOOP
    INSERT INTO public.repayment_schedules
      (rent_request_id, tenant_id, payment_number, due_date, amount, status)
    VALUES (
      p_request_id,
      _row.tenant_id,
      _i,
      (current_date + (_days_between * _i))::date,
      CASE WHEN _i = _new_payments THEN _remainder ELSE _per_payment END,
      'pending'
    );
  END LOOP;

  -- Audit
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
      'previous_rejected_reason', _row.rejected_reason,
      'previous_rejected_at_stage', _row.rejected_at_stage,
      'patch', p_patch
    )
  );

  -- Trust mission: emit system event
  INSERT INTO public.system_events
    (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'rent_request.resubmitted_by_agent',
    auth.uid(),
    'rent_request',
    p_request_id,
    jsonb_build_object(
      'returned_to_status', _next_status,
      'reopen_count', COALESCE(_row.reopen_count, 0) + 1
    )
  );

  RETURN p_request_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.agent_resubmit_rent_request(uuid, jsonb, text) TO authenticated;

-- ---------------------------------------------------------------------
-- RPC: agent_delete_rejected_rent_request
-- Soft-delete: status -> 'deleted_by_agent', preserves all data + ledger.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_delete_rejected_rent_request(
  p_request_id uuid,
  p_reason text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.rent_requests%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Delete reason must be at least 10 characters';
  END IF;

  SELECT * INTO _row FROM public.rent_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rent request not found';
  END IF;

  IF _row.agent_id IS NULL OR _row.agent_id <> auth.uid() THEN
    RAISE EXCEPTION 'Only the agent who created this request can delete it';
  END IF;

  IF _row.status <> 'rejected' THEN
    RAISE EXCEPTION 'Only rejected requests can be deleted (current status: %)', _row.status;
  END IF;

  UPDATE public.rent_requests
     SET status     = 'deleted_by_agent',
         updated_at = now()
   WHERE id = p_request_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
  VALUES (
    'rent_request_deleted_by_agent',
    'rent_requests',
    p_request_id,
    auth.uid(),
    jsonb_build_object(
      'reason', trim(p_reason),
      'previous_rejected_reason', _row.rejected_reason,
      'previous_rejected_at_stage', _row.rejected_at_stage,
      'rent_amount', _row.rent_amount
    )
  );

  INSERT INTO public.system_events
    (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'rent_request.deleted_by_agent',
    auth.uid(),
    'rent_request',
    p_request_id,
    jsonb_build_object('reason', trim(p_reason))
  );

  RETURN p_request_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.agent_delete_rejected_rent_request(uuid, text) TO authenticated;
