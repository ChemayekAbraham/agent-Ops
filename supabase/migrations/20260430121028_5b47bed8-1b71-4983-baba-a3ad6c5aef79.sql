CREATE OR REPLACE FUNCTION public.reopen_rent_request(p_request_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _row public.rent_requests%ROWTYPE;
  _allowed boolean := FALSE;
  _is_ops_dept boolean := FALSE;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reopen reason must be at least 10 characters';
  END IF;

  SELECT * INTO _row FROM public.rent_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rent request not found';
  END IF;

  IF _row.status <> 'rejected' THEN
    RAISE EXCEPTION 'Only rejected requests can be reopened (current status: %)', _row.status;
  END IF;

  -- 3-reopen lock — only manager can act after that
  IF _row.reopen_count >= 3 AND NOT public.has_role(auth.uid(), 'manager'::app_role) THEN
    RAISE EXCEPTION 'Reopen limit reached (3). Only a manager may act on this request.';
  END IF;

  -- Check if user is in any reviewer operations department
  SELECT EXISTS (
    SELECT 1 FROM public.operations_departments
    WHERE user_id = auth.uid()
      AND department IN ('tenant_ops','landlord_ops','agent_ops','partner_ops')
  ) INTO _is_ops_dept;

  -- Authorization: manager + CFO + COO + any ops department reviewer
  _allowed := public.has_role(auth.uid(), 'manager'::app_role)
           OR public.has_role(auth.uid(), 'cfo'::app_role)
           OR public.has_role(auth.uid(), 'coo'::app_role)
           OR _is_ops_dept;

  IF NOT _allowed THEN
    RAISE EXCEPTION 'Not authorized to reopen rent requests';
  END IF;

  UPDATE public.rent_requests
     SET status = COALESCE(_row.rejected_at_stage, 'pending'),
         reopened_at = now(),
         reopened_by = auth.uid(),
         reopen_count = COALESCE(_row.reopen_count, 0) + 1,
         reopen_reason = trim(p_reason),
         updated_at = now()
   WHERE id = p_request_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
  VALUES (
    'rent_request_reopened',
    'rent_requests',
    p_request_id,
    auth.uid(),
    jsonb_build_object(
      'reason', trim(p_reason),
      'returned_to_status', COALESCE(_row.rejected_at_stage, 'pending'),
      'reopen_count', COALESCE(_row.reopen_count, 0) + 1,
      'previous_rejected_reason', _row.rejected_reason
    )
  );

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'rent_request.reopened',
    auth.uid(),
    'rent_request',
    p_request_id,
    jsonb_build_object(
      'reason', trim(p_reason),
      'returned_to_status', COALESCE(_row.rejected_at_stage, 'pending'),
      'reopen_count', COALESCE(_row.reopen_count, 0) + 1
    )
  );

  RETURN p_request_id;
END;
$function$;