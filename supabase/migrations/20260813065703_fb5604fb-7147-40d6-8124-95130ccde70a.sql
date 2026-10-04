-- 1. Rent requests: comment mandatory on BOTH verify and reject
CREATE OR REPLACE FUNCTION public.service_center_review_rent_request(p_request_id uuid, p_decision text, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_req public.rent_requests%ROWTYPE;
  v_actor uuid := auth.uid();
  v_is_ops boolean := public.is_ops_role(auth.uid());
  v_new_status text;
  v_comment text := btrim(coalesce(p_comment, ''));
BEGIN
  IF p_decision NOT IN ('verify','reject') THEN
    RAISE EXCEPTION 'invalid decision';
  END IF;

  IF length(v_comment) < 10 THEN
    RAISE EXCEPTION 'a review comment of at least 10 characters is required';
  END IF;

  SELECT * INTO v_req FROM public.rent_requests WHERE id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL THEN RAISE EXCEPTION 'request not found'; END IF;

  IF v_req.status <> 'service_center_review' THEN
    RAISE EXCEPTION 'request is not awaiting service center review';
  END IF;

  IF NOT v_is_ops AND v_req.service_center_manager_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'not authorized to review this request';
  END IF;

  v_new_status := CASE WHEN p_decision = 'verify' THEN 'pending' ELSE 'rejected' END;

  UPDATE public.rent_requests
     SET status = v_new_status,
         service_center_reviewed_by = v_actor,
         service_center_reviewed_at = now(),
         service_center_comment = v_comment,
         updated_at = now()
   WHERE id = p_request_id;

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    CASE WHEN p_decision = 'verify'
      THEN 'rent_request.service_center_verified'
      ELSE 'rent_request.service_center_rejected' END,
    v_actor,
    'rent_request',
    p_request_id,
    jsonb_build_object(
      'service_center_manager_id', v_req.service_center_manager_id,
      'submitting_agent_id', v_req.agent_id,
      'tenant_id', v_req.tenant_id,
      'previous_status', v_req.status,
      'new_status', v_new_status,
      'comment', v_comment,
      'reviewed_by_ops', v_is_ops
    )
  );

  RETURN jsonb_build_object('success', true, 'request_id', p_request_id, 'status', v_new_status);
END; $function$;

-- 2. House listings: comment mandatory on pass and return
CREATE OR REPLACE FUNCTION public.service_center_review_house_listing(p_listing_id uuid, p_decision text, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_is_ops boolean := public.is_ops_role(auth.uid());
  v_row public.house_listings%ROWTYPE;
  v_new text;
  v_comment text := btrim(coalesce(p_comment, ''));
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_decision NOT IN ('pass','return') THEN RAISE EXCEPTION 'invalid decision'; END IF;
  IF length(v_comment) < 10 THEN
    RAISE EXCEPTION 'a review comment of at least 10 characters is required';
  END IF;

  SELECT * INTO v_row FROM public.house_listings WHERE id = p_listing_id FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'listing not found'; END IF;
  IF v_row.service_center_status <> 'pending' THEN
    RAISE EXCEPTION 'this listing is not awaiting service centre review';
  END IF;
  IF NOT v_is_ops AND v_row.service_center_manager_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'not authorised to review this listing';
  END IF;

  v_new := CASE WHEN p_decision = 'pass' THEN 'passed' ELSE 'returned' END;

  UPDATE public.house_listings
     SET service_center_status = v_new,
         service_center_reviewed_by = v_actor,
         service_center_reviewed_at = now(),
         service_center_comment = v_comment,
         updated_at = now()
   WHERE id = p_listing_id;

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'listing_created',
    v_actor,
    'house_listing',
    p_listing_id,
    jsonb_build_object(
      'action', CASE WHEN p_decision = 'pass' THEN 'service_center_passed' ELSE 'service_center_returned' END,
      'service_center_manager_id', v_row.service_center_manager_id,
      'listing_agent_id', v_row.agent_id,
      'comment', v_comment,
      'reviewed_by_ops', v_is_ops
    )
  );

  RETURN jsonb_build_object('success', true, 'listing_id', p_listing_id, 'service_center_status', v_new);
END;
$function$;

-- 3. Landlord / LC1 chairperson: comment mandatory on pass and return
CREATE OR REPLACE FUNCTION public.service_center_review_verification(p_kind text, p_record_id uuid, p_decision text, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_is_ops boolean := public.is_ops_role(auth.uid());
  v_manager uuid;
  v_agent uuid;
  v_status text;
  v_new text;
  v_comment text := btrim(coalesce(p_comment, ''));
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_kind NOT IN ('landlord','lc1') THEN RAISE EXCEPTION 'invalid kind'; END IF;
  IF p_decision NOT IN ('pass','return') THEN RAISE EXCEPTION 'invalid decision'; END IF;
  IF length(v_comment) < 10 THEN
    RAISE EXCEPTION 'a review comment of at least 10 characters is required';
  END IF;

  v_new := CASE WHEN p_decision = 'pass' THEN 'passed' ELSE 'returned' END;

  IF p_kind = 'landlord' THEN
    SELECT service_center_manager_id, service_center_status, registered_by
      INTO v_manager, v_status, v_agent
      FROM public.landlords WHERE id = p_record_id FOR UPDATE;
  ELSE
    SELECT service_center_manager_id, service_center_status, registered_by
      INTO v_manager, v_status, v_agent
      FROM public.lc1_chairpersons WHERE id = p_record_id FOR UPDATE;
  END IF;

  IF v_status IS NULL THEN RAISE EXCEPTION 'record not found'; END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'this record is not awaiting service centre review';
  END IF;
  IF NOT v_is_ops AND v_manager IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'not authorised to review this record';
  END IF;

  IF p_kind = 'landlord' THEN
    UPDATE public.landlords
       SET service_center_status = v_new,
           service_center_reviewed_by = v_actor,
           service_center_reviewed_at = now(),
           service_center_comment = v_comment,
           updated_at = now()
     WHERE id = p_record_id;
  ELSE
    UPDATE public.lc1_chairpersons
       SET service_center_status = v_new,
           service_center_reviewed_by = v_actor,
           service_center_reviewed_at = now(),
           service_center_comment = v_comment
     WHERE id = p_record_id;
  END IF;

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'listing_created',
    v_actor,
    CASE WHEN p_kind = 'landlord' THEN 'landlord' ELSE 'lc1_chairperson' END,
    p_record_id,
    jsonb_build_object(
      'action', CASE WHEN p_decision = 'pass' THEN 'service_center_passed' ELSE 'service_center_returned' END,
      'kind', p_kind,
      'service_center_manager_id', v_manager,
      'registering_agent_id', v_agent,
      'comment', v_comment,
      'reviewed_by_ops', v_is_ops
    )
  );

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_actor,
    'service_center_verification_review',
    CASE WHEN p_kind = 'landlord' THEN 'landlords' ELSE 'lc1_chairpersons' END,
    p_record_id,
    jsonb_build_object('decision', p_decision, 'reason', v_comment)
  );

  RETURN jsonb_build_object('success', true, 'id', p_record_id, 'kind', p_kind, 'service_center_status', v_new);
END;
$function$;