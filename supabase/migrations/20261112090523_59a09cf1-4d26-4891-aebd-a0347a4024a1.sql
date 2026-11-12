CREATE OR REPLACE FUNCTION public.return_rent_request_for_correction(p_request_id uuid, p_stage text, p_reason text)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _row public.rent_requests%ROWTYPE;
  _uid uuid := auth.uid();
  _reason text := trim(coalesce(p_reason,''));
  _allowed_stages text[] := ARRAY['pending','agent_ops_approved','tenant_ops_approved','landlord_ops_approved','coo_approved','cfo_approved','approved'];
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF length(_reason) < 10 THEN RAISE EXCEPTION 'Rejection reason must be at least 10 characters'; END IF;
  IF NOT (p_stage = ANY(_allowed_stages)) THEN RAISE EXCEPTION 'Invalid stage: %', p_stage; END IF;

  IF NOT (
    has_role(_uid,'operations'::app_role) OR has_role(_uid,'coo'::app_role) OR has_role(_uid,'cfo'::app_role)
    OR has_role(_uid,'manager'::app_role) OR has_role(_uid,'super_admin'::app_role)
    OR has_role(_uid,'agent_ops'::app_role) OR has_role(_uid,'tenant_ops'::app_role)
    OR has_role(_uid,'landlord_ops'::app_role) OR has_role(_uid,'partner_ops'::app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized to return rent requests for correction';
  END IF;

  SELECT * INTO _row FROM public.rent_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rent request not found'; END IF;
  IF _row.status IN ('rejected','funded','disbursed','cancelled') THEN
    RAISE EXCEPTION 'Cannot return request in status: %', _row.status;
  END IF;

  UPDATE public.rent_requests SET
    status='rejected', rejected_reason=_reason, rejected_at_stage=p_stage,
    rejected_at=now(), returned_at=now(), reopen_count=COALESCE(reopen_count,0)+1, updated_at=now(),
    agent_ops_reviewed_by    = CASE WHEN p_stage='pending' THEN _uid ELSE agent_ops_reviewed_by END,
    agent_ops_reviewed_at    = CASE WHEN p_stage='pending' THEN now() ELSE agent_ops_reviewed_at END,
    agent_ops_comment        = CASE WHEN p_stage='pending' THEN _reason ELSE agent_ops_comment END,
    tenant_ops_reviewed_by   = CASE WHEN p_stage='agent_ops_approved' THEN _uid ELSE tenant_ops_reviewed_by END,
    tenant_ops_reviewed_at   = CASE WHEN p_stage='agent_ops_approved' THEN now() ELSE tenant_ops_reviewed_at END,
    tenant_ops_comment       = CASE WHEN p_stage='agent_ops_approved' THEN _reason ELSE tenant_ops_comment END,
    landlord_ops_reviewed_by = CASE WHEN p_stage='tenant_ops_approved' THEN _uid ELSE landlord_ops_reviewed_by END,
    landlord_ops_reviewed_at = CASE WHEN p_stage='tenant_ops_approved' THEN now() ELSE landlord_ops_reviewed_at END,
    landlord_ops_comment     = CASE WHEN p_stage='tenant_ops_approved' THEN _reason ELSE landlord_ops_comment END,
    partner_ops_reviewed_by  = CASE WHEN p_stage='landlord_ops_approved' THEN _uid ELSE partner_ops_reviewed_by END,
    partner_ops_reviewed_at  = CASE WHEN p_stage='landlord_ops_approved' THEN now() ELSE partner_ops_reviewed_at END,
    partner_ops_comment      = CASE WHEN p_stage='landlord_ops_approved' THEN _reason ELSE partner_ops_comment END,
    cfo_reviewed_by          = CASE WHEN p_stage='coo_approved' THEN _uid ELSE cfo_reviewed_by END,
    cfo_reviewed_at          = CASE WHEN p_stage='coo_approved' THEN now() ELSE cfo_reviewed_at END,
    approval_comment         = CASE WHEN p_stage='coo_approved' THEN _reason ELSE approval_comment END
  WHERE id = p_request_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
  VALUES ('rent_request_returned_for_correction','rent_requests',p_request_id,_uid,
    jsonb_build_object('rejected_at_stage',p_stage,'reason',_reason,'previous_status',_row.status));

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES ('rent_request.returned_for_correction',_uid,'rent_request',p_request_id,
    jsonb_build_object('rejected_at_stage',p_stage,'reason',_reason));

  RETURN p_request_id;
END;
$function$;