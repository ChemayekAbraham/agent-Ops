
CREATE OR REPLACE FUNCTION public.get_agents_hub(
  search_query text DEFAULT '',
  sort_field text DEFAULT 'full_name',
  sort_dir text DEFAULT 'asc',
  page_limit integer DEFAULT 50,
  page_offset integer DEFAULT 0,
  active_only boolean DEFAULT true
)
RETURNS TABLE(
  id uuid,
  full_name text,
  phone text,
  territory text,
  last_active_at timestamptz,
  wallet_balance numeric,
  total_commission numeric,
  tenants_count bigint,
  landlords_count bigint,
  total_count bigint
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_total bigint;
BEGIN
  -- Count with filters applied
  SELECT count(*) INTO v_total
  FROM (
    SELECT p.id,
      COALESCE((SELECT COUNT(DISTINCT rr2.tenant_id) FROM rent_requests rr2 WHERE rr2.assigned_agent_id = p.id), 0) AS tc,
      COALESCE((SELECT COUNT(DISTINCT ala.landlord_id) FROM agent_landlord_assignments ala WHERE ala.agent_id = p.id), 0) AS lc
    FROM user_roles ur
    JOIN profiles p ON p.id = ur.user_id
    WHERE ur.role = 'agent'
      AND (search_query = '' OR p.full_name ILIKE '%' || search_query || '%')
  ) sub
  WHERE (NOT active_only OR sub.tc > 0 OR sub.lc > 0);

  RETURN QUERY
  SELECT
    p.id,
    COALESCE(NULLIF(TRIM(p.full_name), ''), 'Unknown Agent') AS full_name,
    p.phone,
    p.territory,
    p.last_active_at,
    COALESCE(w.balance, 0) AS wallet_balance,
    COALESCE(ae.total_commission, 0) AS total_commission,
    COALESCE(rr.tenants_count, 0) AS tenants_count,
    COALESCE(la.landlords_count, 0) AS landlords_count,
    v_total AS total_count
  FROM user_roles ur
  JOIN profiles p ON p.id = ur.user_id
  LEFT JOIN wallets w ON w.user_id = p.id
  LEFT JOIN (
    SELECT agent_id, SUM(amount) AS total_commission
    FROM agent_earnings
    GROUP BY agent_id
  ) ae ON ae.agent_id = p.id
  LEFT JOIN (
    SELECT assigned_agent_id, COUNT(DISTINCT tenant_id) AS tenants_count
    FROM rent_requests
    WHERE assigned_agent_id IS NOT NULL
    GROUP BY assigned_agent_id
  ) rr ON rr.assigned_agent_id = p.id
  LEFT JOIN (
    SELECT agent_id, COUNT(DISTINCT landlord_id) AS landlords_count
    FROM agent_landlord_assignments
    GROUP BY agent_id
  ) la ON la.agent_id = p.id
  WHERE ur.role = 'agent'
    AND (search_query = '' OR p.full_name ILIKE '%' || search_query || '%')
    AND (NOT active_only OR COALESCE(rr.tenants_count, 0) > 0 OR COALESCE(la.landlords_count, 0) > 0)
  ORDER BY
    CASE WHEN sort_field = 'full_name' AND sort_dir = 'asc' THEN COALESCE(NULLIF(TRIM(p.full_name), ''), 'zzz') END ASC,
    CASE WHEN sort_field = 'full_name' AND sort_dir = 'desc' THEN COALESCE(NULLIF(TRIM(p.full_name), ''), '') END DESC,
    CASE WHEN sort_field = 'total_commission' AND sort_dir = 'asc' THEN COALESCE(ae.total_commission, 0) END ASC,
    CASE WHEN sort_field = 'total_commission' AND sort_dir = 'desc' THEN COALESCE(ae.total_commission, 0) END DESC,
    CASE WHEN sort_field = 'wallet_balance' AND sort_dir = 'asc' THEN COALESCE(w.balance, 0) END ASC,
    CASE WHEN sort_field = 'wallet_balance' AND sort_dir = 'desc' THEN COALESCE(w.balance, 0) END DESC,
    CASE WHEN sort_field = 'tenants_count' AND sort_dir = 'asc' THEN COALESCE(rr.tenants_count, 0) END ASC,
    CASE WHEN sort_field = 'tenants_count' AND sort_dir = 'desc' THEN COALESCE(rr.tenants_count, 0) END DESC,
    CASE WHEN sort_field = 'last_active_at' AND sort_dir = 'asc' THEN p.last_active_at END ASC,
    CASE WHEN sort_field = 'last_active_at' AND sort_dir = 'desc' THEN p.last_active_at END DESC,
    COALESCE(NULLIF(TRIM(p.full_name), ''), 'zzz') ASC
  LIMIT page_limit
  OFFSET page_offset;
END;
$$;
