CREATE OR REPLACE FUNCTION public.get_agent_directory_v2(
  p_search text DEFAULT NULL,
  p_type text DEFAULT 'all',
  p_status text DEFAULT 'all',
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_limit int := GREATEST(1, LEAST(100, COALESCE(p_limit,50)));
  v_offset int := GREATEST(0, COALESCE(p_offset,0));
  v_q text := NULLIF(btrim(COALESCE(p_search,'')),'');
BEGIN
  PERFORM public.agent_ops_directory_guard();

  RETURN (
    WITH universe AS (
      SELECT agent_id AS uid FROM public.agent_ops_strict_agent_ids()
    ),
    subs AS (
      SELECT DISTINCT sa.sub_agent_id AS uid FROM agent_subagents sa
       WHERE sa.sub_agent_id IS NOT NULL
    ),
    tenant_counts AS (
      SELECT rr.agent_id AS uid, count(DISTINCT rr.tenant_id) AS n
        FROM rent_requests rr
        JOIN universe u ON u.uid = rr.agent_id
       WHERE rr.tenant_id IS NOT NULL AND rr.tenant_id <> rr.agent_id
       GROUP BY rr.agent_id
    ),
    enriched AS (
      SELECT
        u.uid,
        p.full_name, p.phone, p.email, p.avatar_url, p.verified, p.territory,
        p.region, p.district, p.created_at, p.last_active_at, p.is_frozen,
        p.agent_tier,
        CASE WHEN s.uid IS NOT NULL THEN 'sub_agent' ELSE 'agent' END AS agent_kind,
        COALESCE(tc.n, 0)::int AS total_tenants,
        CASE
          WHEN p.is_frozen THEN 'frozen'
          WHEN p.last_active_at IS NOT NULL AND p.last_active_at >= now() - interval '30 days' THEN 'active'
          ELSE 'inactive'
        END AS status
      FROM universe u
      JOIN profiles p ON p.id = u.uid
      LEFT JOIN subs s ON s.uid = u.uid
      LEFT JOIN tenant_counts tc ON tc.uid = u.uid
    ),
    kpi AS (
      SELECT
        count(*) FILTER (WHERE agent_kind = 'agent')::int AS total_agents,
        count(*) FILTER (WHERE agent_kind = 'sub_agent')::int AS total_sub_agents,
        count(*) FILTER (WHERE status = 'active')::int AS total_active,
        count(*)::int AS total_all
      FROM enriched
    ),
    filtered AS (
      SELECT * FROM enriched e
      WHERE (COALESCE(p_type,'all') = 'all' OR e.agent_kind = p_type)
        AND (COALESCE(p_status,'all') = 'all' OR e.status = p_status)
        AND (
          v_q IS NULL
          OR e.full_name ILIKE '%'||v_q||'%'
          OR e.phone ILIKE '%'||v_q||'%'
          OR e.email ILIKE '%'||v_q||'%'
          OR e.territory ILIKE '%'||v_q||'%'
          OR e.uid::text = v_q
        )
    ),
    page AS (
      SELECT * FROM filtered
      ORDER BY total_tenants DESC, full_name ASC NULLS LAST
      LIMIT v_limit OFFSET v_offset
    ),
    page_metrics AS (
      SELECT
        pg.*,
        (SELECT count(*)::int FROM agent_subagents s WHERE s.parent_agent_id = pg.uid) AS sub_agents_count,
        (SELECT count(*)::int FROM house_listings hl WHERE hl.agent_id = pg.uid) AS houses_listed,
        COALESCE((
          SELECT sum(rr.daily_repayment) FROM rent_requests rr
           WHERE rr.agent_id = pg.uid
             AND rr.status IN ('funded','repaying')
             AND COALESCE(rr.amount_repaid,0) < COALESCE(rr.total_repayment,0)
             AND COALESCE(rr.agent_payment_status,'') <> 'not_paying'
        ),0) AS daily_target,
        COALESCE((
          SELECT GREATEST(0, sum(COALESCE(rr.total_repayment,0)) - sum(COALESCE(rr.amount_repaid,0)))
            FROM rent_requests rr
           WHERE rr.agent_id = pg.uid AND rr.status IN ('funded','repaying')
        ),0) AS outstanding,
        COALESCE((
          SELECT sum(ac.amount) FROM agent_collections ac
           WHERE ac.agent_id = pg.uid AND ac.created_at >= date_trunc('day', now())
        ),0) AS collected_today,
        (SELECT max(ac.created_at) FROM agent_collections ac WHERE ac.agent_id = pg.uid) AS last_collection_at
      FROM page pg
    )
    SELECT jsonb_build_object(
      'kpis', (SELECT to_jsonb(k) FROM kpi k),
      'total_matched', (SELECT count(*)::int FROM filtered),
      'limit', v_limit,
      'offset', v_offset,
      'rows', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', pm.uid,
          'full_name', pm.full_name,
          'phone', pm.phone,
          'email', pm.email,
          'avatar_url', pm.avatar_url,
          'verified', COALESCE(pm.verified,false),
          'territory', pm.territory,
          'region', pm.region,
          'district', pm.district,
          'agent_tier', pm.agent_tier,
          'created_at', pm.created_at,
          'last_active_at', pm.last_active_at,
          'agent_kind', pm.agent_kind,
          'total_tenants', pm.total_tenants,
          'sub_agents_count', pm.sub_agents_count,
          'houses_listed', pm.houses_listed,
          'daily_target', pm.daily_target,
          'collected_today', pm.collected_today,
          'outstanding', pm.outstanding,
          'last_collection_at', pm.last_collection_at,
          'status', pm.status
        ) ORDER BY pm.total_tenants DESC, pm.full_name ASC NULLS LAST)
        FROM page_metrics pm
      ), '[]'::jsonb)
    )
  );
END;
$$;