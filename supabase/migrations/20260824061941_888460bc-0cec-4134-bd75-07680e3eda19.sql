CREATE OR REPLACE FUNCTION public.ceo_approve_service_centres(p_ids uuid[], p_comment text)
RETURNS TABLE(id uuid, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_comment text := btrim(coalesce(p_comment, ''));
  r record;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT (public.has_role(v_actor, 'coo') OR public.has_role(v_actor, 'manager')
          OR public.has_role(v_actor, 'ceo') OR public.has_role(v_actor, 'super_admin')) THEN
    RAISE EXCEPTION 'Only the COO can vet service centres';
  END IF;
  IF length(v_comment) < 10 THEN
    RAISE EXCEPTION 'A comment of at least 10 characters is required';
  END IF;
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'Select at least one service centre';
  END IF;

  FOR r IN
    UPDATE public.service_centre_setups s
       SET status = 'active',
           ceo_approved_by = v_actor,
           ceo_approved_at = now(),
           ceo_comment = v_comment,
           approved_by = v_actor,
           approved_at = now()
     WHERE s.id = ANY(p_ids)
       AND s.status = 'verified'
    RETURNING s.id, s.status
  LOOP
    INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, reason, metadata)
    VALUES (v_actor, 'service_centre_coo_approved', 'service_centre_coo_approved',
            'service_centre_setups', r.id, v_comment,
            jsonb_build_object('status', 'active'));
    id := r.id; status := r.status;
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.ceo_reject_service_centres(p_ids uuid[], p_comment text)
RETURNS TABLE(id uuid, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_comment text := btrim(coalesce(p_comment, ''));
  r record;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT (public.has_role(v_actor, 'coo') OR public.has_role(v_actor, 'manager')
          OR public.has_role(v_actor, 'ceo') OR public.has_role(v_actor, 'super_admin')) THEN
    RAISE EXCEPTION 'Only the COO can vet service centres';
  END IF;
  IF length(v_comment) < 10 THEN
    RAISE EXCEPTION 'A rejection reason of at least 10 characters is required';
  END IF;
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'Select at least one service centre';
  END IF;

  FOR r IN
    UPDATE public.service_centre_setups s
       SET status = 'rejected',
           ceo_rejection_reason = v_comment,
           ceo_approved_by = v_actor,
           ceo_approved_at = now()
     WHERE s.id = ANY(p_ids)
       AND s.status = 'verified'
    RETURNING s.id, s.status
  LOOP
    INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, reason, metadata)
    VALUES (v_actor, 'service_centre_coo_rejected', 'service_centre_coo_rejected',
            'service_centre_setups', r.id, v_comment,
            jsonb_build_object('status', 'rejected'));
    id := r.id; status := r.status;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.ceo_approve_service_centres(uuid[], text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ceo_reject_service_centres(uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ceo_approve_service_centres(uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ceo_reject_service_centres(uuid[], text) TO authenticated;