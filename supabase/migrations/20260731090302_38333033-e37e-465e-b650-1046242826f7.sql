CREATE OR REPLACE FUNCTION public.is_service_center_reviewer(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND enabled = true
      AND role IN ('manager','super_admin','coo','operations','agent_ops','ceo','cto','cfo')
  );
$$;

CREATE OR REPLACE FUNCTION public.admin_list_service_center_requests(p_status text DEFAULT NULL, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows jsonb; v_total integer;
BEGIN
  IF NOT public.is_service_center_reviewer(auth.uid()) THEN RAISE EXCEPTION 'not authorized'; END IF;
  SELECT count(*) INTO v_total FROM public.service_center_requests r
   WHERE p_status IS NULL OR r.status = p_status;
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at' DESC), '[]'::jsonb) INTO v_rows FROM (
    SELECT to_jsonb(r) || jsonb_build_object(
      'agent_full_name', pr.full_name,
      'agent_phone_profile', pr.phone
    ) AS x
    FROM public.service_center_requests r
    LEFT JOIN public.profiles pr ON pr.id = r.agent_id
    WHERE p_status IS NULL OR r.status = p_status
    ORDER BY r.created_at DESC
    LIMIT COALESCE(p_limit, 100) OFFSET COALESCE(p_offset, 0)
  ) s;
  RETURN jsonb_build_object('total', v_total, 'rows', v_rows);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_decide_service_center_request(p_request_id uuid, p_decision text, p_reason text DEFAULT NULL, p_internal_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_status text;
BEGIN
  IF NOT public.is_service_center_reviewer(auth.uid()) THEN RAISE EXCEPTION 'not authorized'; END IF;
  v_status := CASE p_decision
    WHEN 'approve' THEN 'approved'
    WHEN 'reject' THEN 'rejected'
    WHEN 'more_info' THEN 'more_info_requested'
    ELSE NULL END;
  IF p_decision = 'reject' AND coalesce(trim(p_reason),'') = '' THEN
    RAISE EXCEPTION 'A rejection reason is required';
  END IF;
  UPDATE public.service_center_requests
     SET status = COALESCE(v_status, status),
         decision_reason = COALESCE(NULLIF(trim(coalesce(p_reason,'')),''), decision_reason),
         internal_note = COALESCE(NULLIF(trim(coalesce(p_internal_note,'')),''), internal_note),
         reviewed_by = CASE WHEN v_status IS NULL THEN reviewed_by ELSE auth.uid() END,
         reviewed_at = CASE WHEN v_status IS NULL THEN reviewed_at ELSE now() END,
         updated_at = now()
   WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'request not found'; END IF;
  RETURN jsonb_build_object('ok', true, 'status', COALESCE(v_status, 'noted'));
END;
$$;