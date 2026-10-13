-- COO rent approvals: let the COO move a rent plan on to the CFO, or return it, without a direct table write.
--
-- Why: the COO stage of the rent pipeline (status 'partner_ops_approved') was done from the web by a direct UPDATE of
-- public.rent_requests, but the only UPDATE policy on that table is for managers (plus agents and supporters on their own rows),
-- so a COO-only account updates zero rows and sees no error. The return path called return_rent_request_for_correction with the
-- stage 'partner_ops_approved', which that function does not accept ("Invalid stage"). These two SECURITY DEFINER functions
-- do the same two actions with their own role check, a status check under a row lock, and an audit trail.
--
--   coo_approve_rent_request(p_request_id, p_comment)  partner_ops_approved -> coo_approved   (forward to the CFO)
--   coo_return_rent_request(p_request_id, p_reason)    partner_ops_approved -> rejected       (returned for correction at the COO step)
--
-- Both: COO or super_admin only; the request must still be at the COO step; outstanding-balance plans never reach this step and are
-- refused; the person who registered the request (or is assigned to it) cannot decide it.

CREATE OR REPLACE FUNCTION public.coo_approve_rent_request(p_request_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.rent_requests%ROWTYPE;
  v_comment text := NULLIF(btrim(COALESCE(p_comment, '')), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF NOT (public.has_role(v_uid, 'coo'::public.app_role) OR public.has_role(v_uid, 'super_admin'::public.app_role)) THEN
    RAISE EXCEPTION 'Only the COO can approve a rent request at the COO step' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.rent_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rent request not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_row.status IS DISTINCT FROM 'partner_ops_approved' THEN
    RAISE EXCEPTION 'ALREADY_MOVED: this rent request is at "%", not waiting for the COO', v_row.status USING ERRCODE = 'check_violation';
  END IF;

  IF COALESCE(v_row.registration_type, 'normal') = 'outstanding_balance' THEN
    RAISE EXCEPTION 'Outstanding-balance rent requests do not go through COO approval' USING ERRCODE = 'check_violation';
  END IF;

  IF v_uid = v_row.agent_id OR v_uid = v_row.assigned_agent_id THEN
    RAISE EXCEPTION 'You cannot approve a rent request you registered or are assigned to' USING ERRCODE = '42501';
  END IF;

  UPDATE public.rent_requests
     SET status = 'coo_approved',
         coo_reviewed_by = v_uid,
         coo_reviewed_at = now(),
         approval_comment = v_comment,
         updated_at = now()
   WHERE id = p_request_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
  VALUES (
    'coo_approved_rent_request', 'rent_requests', p_request_id, v_uid,
    jsonb_build_object('previous_status', v_row.status, 'new_status', 'coo_approved', 'comment', v_comment,
                       'rent_amount', v_row.rent_amount, 'tenant_id', v_row.tenant_id)
  );

  RETURN jsonb_build_object('id', p_request_id, 'status', 'coo_approved');
END;
$function$;

CREATE OR REPLACE FUNCTION public.coo_return_rent_request(p_request_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.rent_requests%ROWTYPE;
  v_reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF NOT (public.has_role(v_uid, 'coo'::public.app_role) OR public.has_role(v_uid, 'super_admin'::public.app_role)) THEN
    RAISE EXCEPTION 'Only the COO can return a rent request at the COO step' USING ERRCODE = '42501';
  END IF;

  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'The reason must be at least 10 characters' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_row FROM public.rent_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rent request not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_row.status IS DISTINCT FROM 'partner_ops_approved' THEN
    RAISE EXCEPTION 'ALREADY_MOVED: this rent request is at "%", not waiting for the COO', v_row.status USING ERRCODE = 'check_violation';
  END IF;

  IF v_uid = v_row.agent_id OR v_uid = v_row.assigned_agent_id THEN
    RAISE EXCEPTION 'You cannot return a rent request you registered or are assigned to' USING ERRCODE = '42501';
  END IF;

  UPDATE public.rent_requests
     SET status = 'rejected',
         rejected_reason = v_reason,
         rejected_at_stage = 'partner_ops_approved',
         rejected_at = now(),
         returned_at = now(),
         reopen_count = COALESCE(reopen_count, 0) + 1,
         coo_reviewed_by = v_uid,
         coo_reviewed_at = now(),
         approval_comment = v_reason,
         updated_at = now()
   WHERE id = p_request_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
  VALUES (
    'rent_request_returned_for_correction', 'rent_requests', p_request_id, v_uid,
    jsonb_build_object('rejected_at_stage', 'partner_ops_approved', 'reason', v_reason, 'previous_status', v_row.status)
  );

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'rent_request.returned_for_correction', v_uid, 'rent_request', p_request_id,
    jsonb_build_object('rejected_at_stage', 'partner_ops_approved', 'reason', v_reason)
  );

  RETURN jsonb_build_object('id', p_request_id, 'status', 'rejected');
END;
$function$;

REVOKE ALL ON FUNCTION public.coo_approve_rent_request(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.coo_return_rent_request(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.coo_approve_rent_request(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.coo_return_rent_request(uuid, text) TO authenticated;
