-- 1) Add missing enum value (must be its own statement, no transaction wrapping)
ALTER TYPE public.system_event_type ADD VALUE IF NOT EXISTS 'rent_request_force_approved';

-- 2) Replace function to emit the corrected enum value
CREATE OR REPLACE FUNCTION public.force_approve_rejected_rent_request(p_request_id uuid, p_reason text, p_payout_ref text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _row public.rent_requests%ROWTYPE;
  _next text;
  _stage text;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'manager'::app_role)
          OR public.has_role(auth.uid(), 'cfo'::app_role)) THEN
    RAISE EXCEPTION 'Only manager or CFO may force-approve a rejected request';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Override reason must be at least 10 characters';
  END IF;

  SELECT * INTO _row FROM public.rent_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rent request not found';
  END IF;
  IF _row.status <> 'rejected' THEN
    RAISE EXCEPTION 'Only rejected requests can be force-approved (current: %)', _row.status;
  END IF;

  _stage := COALESCE(_row.rejected_at_stage, 'pending');
  _next := CASE _stage
    WHEN 'pending'                THEN 'tenant_ops_approved'
    WHEN 'tenant_ops_approved'    THEN 'agent_verified'
    WHEN 'agent_verified'         THEN 'landlord_ops_approved'
    WHEN 'landlord_ops_approved'  THEN 'coo_approved'
    WHEN 'coo_approved'           THEN 'funded'
    ELSE 'tenant_ops_approved'
  END;

  IF _next = 'funded' AND (p_payout_ref IS NULL OR length(trim(p_payout_ref)) < 1) THEN
    RAISE EXCEPTION 'Transaction reference (TID) is required when force-funding a request';
  END IF;

  UPDATE public.rent_requests
     SET status = _next,
         reopened_at = now(),
         reopened_by = auth.uid(),
         reopen_count = COALESCE(_row.reopen_count, 0) + 1,
         reopen_reason = trim(p_reason),
         payout_transaction_reference = COALESCE(p_payout_ref, payout_transaction_reference),
         updated_at = now()
   WHERE id = p_request_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
  VALUES (
    'rent_request_force_approved',
    'rent_requests',
    p_request_id,
    auth.uid(),
    jsonb_build_object(
      'reason', trim(p_reason),
      'from_rejected_stage', _stage,
      'advanced_to', _next,
      'payout_ref', p_payout_ref,
      'previous_rejected_reason', _row.rejected_reason
    )
  );

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'rent_request_force_approved',
    auth.uid(),
    'rent_request',
    p_request_id,
    jsonb_build_object(
      'reason', trim(p_reason),
      'from_rejected_stage', _stage,
      'advanced_to', _next
    )
  );

  RETURN p_request_id;
END;
$function$;