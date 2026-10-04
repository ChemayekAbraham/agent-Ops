CREATE OR REPLACE FUNCTION public.get_agent_request_history(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_tenant uuid;
  v_events jsonb;
  v_repayments jsonb;
BEGIN
  SELECT agent_id, tenant_id INTO v_owner, v_tenant
  FROM public.rent_requests
  WHERE id = p_request_id;

  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('events', '[]'::jsonb, 'repayments', '[]'::jsonb);
  END IF;

  -- Only the owning agent or staff may view the history
  IF NOT (
    v_owner = auth.uid()
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'ceo'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'operations'::app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized to view this request history';
  END IF;

  SELECT COALESCE(jsonb_agg(e ORDER BY e_created_at ASC), '[]'::jsonb) INTO v_events
  FROM (
    SELECT jsonb_build_object(
      'id', id,
      'event_type', event_type::text,
      'metadata', metadata,
      'created_at', created_at
    ) AS e, created_at AS e_created_at
    FROM public.system_events
    WHERE related_entity_type = 'rent_request'
      AND related_entity_id = p_request_id
  ) s;

  SELECT COALESCE(jsonb_agg(r ORDER BY r_created_at DESC), '[]'::jsonb) INTO v_repayments
  FROM (
    SELECT jsonb_build_object(
      'id', id,
      'amount', amount,
      'created_at', created_at
    ) AS r, created_at AS r_created_at
    FROM public.repayments
    WHERE rent_request_id = p_request_id
  ) rp;

  RETURN jsonb_build_object('events', v_events, 'repayments', v_repayments);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_request_history(uuid) TO authenticated;