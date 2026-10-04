CREATE OR REPLACE FUNCTION public.agent_cancel_rent_request(p_request_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.rent_requests%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Cancellation reason must be at least 10 characters';
  END IF;

  SELECT * INTO _row FROM public.rent_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rent request not found';
  END IF;

  IF _row.agent_id IS NULL OR _row.agent_id <> auth.uid() THEN
    RAISE EXCEPTION 'Only the agent who created this request can cancel it';
  END IF;

  IF _row.status NOT IN ('pending', 'approved', 'rejected') THEN
    RAISE EXCEPTION 'Only requests that have not been funded can be cancelled (current status: %)', _row.status;
  END IF;

  IF _row.funded_at IS NOT NULL OR _row.disbursed_at IS NOT NULL THEN
    RAISE EXCEPTION 'This request has already been funded and cannot be cancelled';
  END IF;

  UPDATE public.rent_requests
     SET status = 'deleted_by_agent',
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
      'previous_status', _row.status,
      'rent_amount', _row.rent_amount,
      'tenant_id', _row.tenant_id,
      'landlord_id', _row.landlord_id
    )
  );

  INSERT INTO public.system_events
    (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'rent_request.deleted_by_agent',
    auth.uid(),
    'rent_request',
    p_request_id,
    jsonb_build_object('reason', trim(p_reason), 'previous_status', _row.status)
  );

  RETURN p_request_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.agent_cancel_rent_request(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_cancel_rent_request(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.tenant_ops_correct_rent_request(
  p_rent_request_id uuid,
  p_rent_amount numeric DEFAULT NULL,
  p_duration_days integer DEFAULT NULL,
  p_access_fee numeric DEFAULT NULL,
  p_request_fee numeric DEFAULT NULL,
  p_total_repayment numeric DEFAULT NULL,
  p_daily_repayment numeric DEFAULT NULL,
  p_amount_repaid numeric DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  rent_amount numeric,
  duration_days integer,
  access_fee numeric,
  request_fee numeric,
  total_repayment numeric,
  daily_repayment numeric,
  amount_repaid numeric,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_before public.rent_requests%ROWTYPE;
  v_reason text := trim(coalesce(p_reason, ''));
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  IF NOT (
    public.has_role(v_actor, 'manager'::public.app_role)
    OR public.has_role(v_actor, 'operations'::public.app_role)
    OR public.has_role(v_actor, 'coo'::public.app_role)
    OR public.has_role(v_actor, 'cfo'::public.app_role)
    OR public.has_role(v_actor, 'ceo'::public.app_role)
    OR public.has_role(v_actor, 'super_admin'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized to correct rent requests';
  END IF;

  SELECT * INTO v_before
  FROM public.rent_requests rr
  WHERE rr.id = p_rent_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rent request not found';
  END IF;

  IF lower(coalesce(v_before.status, '')) IN ('deleted_by_agent', 'rejected', 'cancelled', 'closed') THEN
    RAISE EXCEPTION 'This rent request is % and can no longer be corrected', v_before.status;
  END IF;

  IF p_amount_repaid IS NOT NULL AND p_amount_repaid < 0 THEN
    RAISE EXCEPTION 'Amount repaid cannot be negative';
  END IF;

  UPDATE public.rent_requests rr
     SET rent_amount      = COALESCE(p_rent_amount, rr.rent_amount),
         duration_days    = COALESCE(p_duration_days, rr.duration_days),
         access_fee       = COALESCE(p_access_fee, rr.access_fee),
         request_fee      = COALESCE(p_request_fee, rr.request_fee),
         total_repayment  = COALESCE(p_total_repayment, rr.total_repayment),
         daily_repayment  = COALESCE(p_daily_repayment, rr.daily_repayment),
         amount_repaid    = COALESCE(p_amount_repaid, rr.amount_repaid),
         updated_at       = now()
   WHERE rr.id = p_rent_request_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
  VALUES (
    'tenant_ops_rent_request_correction',
    'rent_requests',
    p_rent_request_id,
    v_actor,
    jsonb_build_object(
      'reason', v_reason,
      'before', jsonb_build_object(
        'rent_amount', v_before.rent_amount,
        'duration_days', v_before.duration_days,
        'access_fee', v_before.access_fee,
        'request_fee', v_before.request_fee,
        'total_repayment', v_before.total_repayment,
        'daily_repayment', v_before.daily_repayment,
        'amount_repaid', v_before.amount_repaid
      ),
      'after', jsonb_build_object(
        'rent_amount', COALESCE(p_rent_amount, v_before.rent_amount),
        'duration_days', COALESCE(p_duration_days, v_before.duration_days),
        'access_fee', COALESCE(p_access_fee, v_before.access_fee),
        'request_fee', COALESCE(p_request_fee, v_before.request_fee),
        'total_repayment', COALESCE(p_total_repayment, v_before.total_repayment),
        'daily_repayment', COALESCE(p_daily_repayment, v_before.daily_repayment),
        'amount_repaid', COALESCE(p_amount_repaid, v_before.amount_repaid)
      )
    )
  );

  RETURN QUERY
  SELECT rr.id, rr.rent_amount, rr.duration_days, rr.access_fee, rr.request_fee,
         rr.total_repayment, rr.daily_repayment, rr.amount_repaid, rr.status
  FROM public.rent_requests rr
  WHERE rr.id = p_rent_request_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.tenant_ops_correct_rent_request(uuid, numeric, integer, numeric, numeric, numeric, numeric, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_ops_correct_rent_request(uuid, numeric, integer, numeric, numeric, numeric, numeric, numeric, text) TO service_role;