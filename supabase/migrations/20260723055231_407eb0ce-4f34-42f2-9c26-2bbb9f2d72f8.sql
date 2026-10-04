
CREATE OR REPLACE FUNCTION public.get_agent_subagent_listing_breakdown(p_parent_agent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_authorized boolean := false;
  v_week_start timestamptz := date_trunc('week', now() AT TIME ZONE 'UTC');
  v_week_end timestamptz := date_trunc('week', now() AT TIME ZONE 'UTC') + interval '7 days';
  v_rows jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = v_uid
      AND role::text IN ('manager','operations','COO','CEO','CFO','super_admin')
  ) OR EXISTS (
    SELECT 1 FROM public.staff_permissions
    WHERE user_id = v_uid
      AND permitted_dashboard IN ('agent_ops','agent-ops','all')
  ) OR v_uid = p_parent_agent_id INTO v_authorized;

  IF NOT v_authorized THEN RAISE EXCEPTION 'Not authorized'; END IF;

  WITH subs AS (
    SELECT sa.sub_agent_id, sa.status, sa.created_at
    FROM public.agent_subagents sa
    WHERE sa.parent_agent_id = p_parent_agent_id
  ),
  listing_counts AS (
    SELECT hl.agent_id,
           COUNT(*) FILTER (WHERE hl.created_at >= v_week_start AND hl.created_at < v_week_end) AS listed_week,
           COUNT(*) FILTER (WHERE hl.verified_at IS NOT NULL AND hl.verified_at >= v_week_start AND hl.verified_at < v_week_end) AS verified_week,
           COUNT(*) AS listed_total,
           COUNT(*) FILTER (WHERE hl.verified_at IS NOT NULL) AS verified_total
    FROM public.house_listings hl
    WHERE hl.agent_id IN (SELECT sub_agent_id FROM subs)
    GROUP BY hl.agent_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'sub_agent_id', s.sub_agent_id,
    'name', COALESCE(p.full_name, p.phone, 'Sub-agent'),
    'phone', p.phone,
    'status', s.status,
    'invited_at', s.created_at,
    'listed_week', COALESCE(lc.listed_week, 0),
    'verified_week', COALESCE(lc.verified_week, 0),
    'listed_total', COALESCE(lc.listed_total, 0),
    'verified_total', COALESCE(lc.verified_total, 0)
  ) ORDER BY COALESCE(lc.verified_week, 0) DESC, COALESCE(lc.listed_week, 0) DESC), '[]'::jsonb)
  INTO v_rows
  FROM subs s
  LEFT JOIN public.profiles p ON p.id = s.sub_agent_id
  LEFT JOIN listing_counts lc ON lc.agent_id = s.sub_agent_id;

  RETURN jsonb_build_object(
    'parent_agent_id', p_parent_agent_id,
    'week_start', v_week_start,
    'week_end', v_week_end,
    'sub_agents', v_rows,
    'total_sub_agents', jsonb_array_length(v_rows)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_subagent_listing_breakdown(uuid) TO authenticated;
