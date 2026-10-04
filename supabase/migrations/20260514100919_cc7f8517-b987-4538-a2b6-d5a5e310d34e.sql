CREATE OR REPLACE FUNCTION public.return_rent_request_for_correction(p_request_id uuid, p_stage text, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    has_role(_uid, 'operations'::app_role)
    OR has_role(_uid, 'coo'::app_role)
    OR has_role(_uid, 'cfo'::app_role)
    OR has_role(_uid, 'manager'::app_role)
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
$function$;