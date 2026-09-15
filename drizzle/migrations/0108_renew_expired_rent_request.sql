ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS pending_window_reset_at timestamptz,
  ADD COLUMN IF NOT EXISTS pending_window_reset_by uuid,
  ADD COLUMN IF NOT EXISTS pending_window_reset_count integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.renew_expired_rent_request(
  p_request_id uuid,
  p_reason text DEFAULT 'Renewed expired pending rent request window'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.rent_requests;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'super_admin')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT * INTO v_row FROM public.rent_requests WHERE id = p_request_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'request_not_found';
  END IF;

  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'only_pending_requests_can_be_renewed';
  END IF;

  UPDATE public.rent_requests
     SET pending_window_reset_at = now(),
         pending_window_reset_by = auth.uid(),
         pending_window_reset_count = COALESCE(pending_window_reset_count, 0) + 1,
         updated_at = now()
   WHERE id = p_request_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (
    auth.uid(),
    'rent_request_window_renewed',
    'rent_requests',
    p_request_id,
    COALESCE(NULLIF(btrim(p_reason), ''), 'Renewed expired pending rent request window'),
    jsonb_build_object(
      'created_at', v_row.created_at,
      'previous_reset_at', v_row.pending_window_reset_at,
      'renew_count', COALESCE(v_row.pending_window_reset_count, 0) + 1
    )
  );

  INSERT INTO public.system_events (event_type, user_id, metadata)
  VALUES (
    'rent_request.resubmitted_by_agent',
    v_row.tenant_id,
    jsonb_build_object('rent_request_id', p_request_id, 'action', 'pending_window_renewed', 'renewed_by', auth.uid())
  );

  RETURN jsonb_build_object('ok', true, 'request_id', p_request_id, 'renewed_at', now());
END;
$$;

GRANT EXECUTE ON FUNCTION public.renew_expired_rent_request(uuid, text) TO authenticated;