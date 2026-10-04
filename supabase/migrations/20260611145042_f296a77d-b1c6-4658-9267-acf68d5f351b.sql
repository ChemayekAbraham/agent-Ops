CREATE OR REPLACE FUNCTION public.get_subagent_recruiter_splits(p_sub_agent_id uuid)
RETURNS TABLE (
  trace_id uuid,
  created_at timestamptz,
  tracking_id text,
  tenant_name text,
  amount numeric,
  total_commission numeric,
  subagent_share numeric,
  recruiter_override numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_parent uuid := auth.uid();
BEGIN
  -- Only the recruiting (parent) agent of this sub-agent may read the splits.
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_subagents sa
    WHERE sa.sub_agent_id = p_sub_agent_id
      AND sa.parent_agent_id = v_parent
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    t.id,
    t.created_at,
    t.tracking_id,
    COALESCE(p.full_name, 'Tenant') AS tenant_name,
    t.amount,
    round(t.amount * 0.10, 2) AS total_commission,
    t.commission_earned AS subagent_share,
    COALESCE((
      SELECT SUM((leg->>'amount')::numeric)
      FROM jsonb_array_elements(t.legs) AS leg
      WHERE leg->>'category' = 'agent_commission_earned'
        AND leg->>'user_id' = v_parent::text
    ), 0) AS recruiter_override
  FROM public.agent_allocation_traces t
  LEFT JOIN public.profiles p ON p.id = t.tenant_id
  WHERE t.agent_id = p_sub_agent_id
  ORDER BY t.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_subagent_recruiter_splits(uuid) TO authenticated;