CREATE OR REPLACE FUNCTION public.get_house_activity_timeline(p_house_id uuid)
RETURNS TABLE (
  id uuid,
  action_type text,
  reason text,
  metadata jsonb,
  actor_id uuid,
  actor_name text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_house record;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT agent_id, landlord_id INTO v_house FROM public.house_listings WHERE id = p_house_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'House not found'; END IF;

  -- Authorize: manager, landlord_ops, the house's agent, or the house's landlord
  IF NOT (
    public.has_role(v_caller, 'manager')
    OR public.has_role(v_caller, 'landlord_ops')
    OR v_caller = v_house.agent_id
    OR v_caller = v_house.landlord_id
  ) THEN
    RAISE EXCEPTION 'Not authorized to view this house timeline';
  END IF;

  RETURN QUERY
  SELECT a.id, a.action_type, a.reason, a.metadata,
         a.user_id AS actor_id,
         COALESCE(p.full_name, 'System') AS actor_name,
         a.created_at
  FROM public.audit_logs a
  LEFT JOIN public.profiles p ON p.id = a.user_id
  WHERE a.table_name = 'house_listings'
    AND a.record_id = p_house_id
    AND a.action_type IN (
      'tenant_bound_to_house',
      'tenant_removed_from_house',
      'house_agent_reassigned'
    )
  ORDER BY a.created_at DESC
  LIMIT 200;
END;
$$;

REVOKE ALL ON FUNCTION public.get_house_activity_timeline(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_house_activity_timeline(uuid) TO authenticated;