-- get_house_activity_timeline returns a column named id, so the unqualified `WHERE id = p_house_id` in its first
-- lookup was ambiguous between that output column and house_listings.id ("column reference id is ambiguous", 17
-- failures 10-29 to 10-30 02:44 UTC). audit_logs.record_id is text, so the timeline filter also compared text with
-- a uuid and would have failed next; cast the id. Body otherwise unchanged. CREATE OR REPLACE keeps the grants.
-- Applied to production by hand; this file is the record.
CREATE OR REPLACE FUNCTION public.get_house_activity_timeline(p_house_id uuid)
 RETURNS TABLE(id uuid, action_type text, reason text, metadata jsonb, actor_id uuid, actor_name text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_house record;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT hl.agent_id, hl.landlord_id INTO v_house FROM public.house_listings hl WHERE hl.id = p_house_id;
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
    AND a.record_id = p_house_id::text
    AND a.action_type IN (
      'tenant_bound_to_house',
      'tenant_removed_from_house',
      'house_agent_reassigned'
    )
  ORDER BY a.created_at DESC
  LIMIT 200;
END;
$function$;
