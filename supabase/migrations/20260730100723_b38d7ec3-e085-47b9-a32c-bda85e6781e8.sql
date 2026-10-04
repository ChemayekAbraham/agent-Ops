CREATE OR REPLACE FUNCTION public.agent_ops_directory_guard()
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;
  IF NOT (
    public.is_ops_role(v_uid)
    OR public.has_role(v_uid,'manager') OR public.has_role(v_uid,'cfo')
    OR public.has_role(v_uid,'ceo') OR public.has_role(v_uid,'coo')
    OR public.has_role(v_uid,'cto') OR public.has_role(v_uid,'super_admin')
  ) THEN RAISE EXCEPTION 'not_authorized'; END IF;
  RETURN v_uid;
END;
$$;

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
  v_out jsonb;
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
        p.created_at, p.last_active_at, p.is_frozen,
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
    )
    SELECT jsonb_build_object(
      'kpis', (SELECT to_jsonb(k) FROM kpi k),
      'total_matched', (SELECT count(*)::int FROM filtered),
      'limit', v_limit,
      'offset', v_offset,
      'rows', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', pg.uid,
          'full_name', pg.full_name,
          'phone', pg.phone,
          'email', pg.email,
          'avatar_url', pg.avatar_url,
          'verified', COALESCE(pg.verified,false),
          'territory', pg.territory,
          'created_at', pg.created_at,
          'last_active_at', pg.last_active_at,
          'agent_kind', pg.agent_kind,
          'total_tenants', pg.total_tenants,
          'status', pg.status
        ) ORDER BY pg.total_tenants DESC, pg.full_name ASC NULLS LAST)
        FROM page pg
      ), '[]'::jsonb)
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_agent_profile_360(p_agent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_out jsonb;
BEGIN
  PERFORM public.agent_ops_directory_guard();
  IF p_agent_id IS NULL THEN RAISE EXCEPTION 'agent_id_required'; END IF;

  SELECT jsonb_build_object(
    'bio', (
      SELECT jsonb_build_object(
        'id', p.id, 'full_name', p.full_name, 'phone', p.phone, 'email', p.email,
        'avatar_url', p.avatar_url, 'verified', COALESCE(p.verified,false),
        'created_at', p.created_at, 'last_active_at', p.last_active_at,
        'territory', p.territory, 'region', p.region, 'district', p.district,
        'sub_county', p.sub_county, 'village', p.village,
        'national_id', p.national_id, 'agent_tier', p.agent_tier,
        'is_frozen', COALESCE(p.is_frozen,false), 'frozen_reason', p.frozen_reason,
        'mobile_money_number', p.mobile_money_number,
        'mobile_money_name', p.mobile_money_name,
        'agent_kind', CASE WHEN EXISTS (SELECT 1 FROM agent_subagents s WHERE s.sub_agent_id = p.id) THEN 'sub_agent' ELSE 'agent' END,
        'parent_agent', (
          SELECT jsonb_build_object('id', pp.id, 'full_name', pp.full_name, 'phone', pp.phone)
            FROM agent_subagents s JOIN profiles pp ON pp.id = s.parent_agent_id
           WHERE s.sub_agent_id = p.id ORDER BY s.created_at DESC LIMIT 1
        )
      ) FROM profiles p WHERE p.id = p_agent_id
    ),
    'rent_requests', (
      SELECT jsonb_build_object(
        'total', count(*)::int,
        'active', count(*) FILTER (WHERE rr.status IN ('funded','repaying','active'))::int,
        'pending', count(*) FILTER (WHERE rr.status IN ('pending','in_review','approved'))::int,
        'rejected', count(*) FILTER (WHERE rr.status ILIKE 'rejected%')::int,
        'completed', count(*) FILTER (WHERE rr.status IN ('completed','closed'))::int,
        'recent', COALESCE((
          SELECT jsonb_agg(x) FROM (
            SELECT r.id, r.status, r.rent_amount, r.total_repayment, r.amount_repaid,
                   r.daily_repayment, r.created_at,
                   (SELECT tp.full_name FROM profiles tp WHERE tp.id = r.tenant_id) AS tenant_name
              FROM rent_requests r WHERE r.agent_id = p_agent_id
             ORDER BY r.created_at DESC LIMIT 10
          ) x), '[]'::jsonb)
      ) FROM rent_requests rr WHERE rr.agent_id = p_agent_id
    ),
    'repayments', (
      SELECT jsonb_build_object(
        'expected_total', COALESCE(sum(rr.total_repayment),0),
        'repaid_total', COALESCE(sum(rr.amount_repaid),0),
        'outstanding_total', GREATEST(0, COALESCE(sum(rr.total_repayment),0) - COALESCE(sum(rr.amount_repaid),0)),
        'daily_target', COALESCE(sum(rr.daily_repayment) FILTER (
          WHERE rr.status IN ('funded','repaying')
            AND COALESCE(rr.amount_repaid,0) < COALESCE(rr.total_repayment,0)
            AND COALESCE(rr.agent_payment_status,'') <> 'not_paying'), 0)
      ) FROM rent_requests rr WHERE rr.agent_id = p_agent_id
    ),
    'collections', (
      SELECT jsonb_build_object(
        'count', count(*)::int,
        'total', COALESCE(sum(ac.amount),0),
        'today', COALESCE(sum(ac.amount) FILTER (WHERE ac.created_at >= date_trunc('day', now())),0),
        'last_30d', COALESCE(sum(ac.amount) FILTER (WHERE ac.created_at >= now() - interval '30 days'),0),
        'recent', COALESCE((
          SELECT jsonb_agg(x) FROM (
            SELECT c.id, c.amount, c.payment_method, c.created_at,
                   (SELECT tp.full_name FROM profiles tp WHERE tp.id = c.tenant_id) AS tenant_name
              FROM agent_collections c WHERE c.agent_id = p_agent_id
             ORDER BY c.created_at DESC LIMIT 10
          ) x), '[]'::jsonb)
      ) FROM agent_collections ac WHERE ac.agent_id = p_agent_id
    ),
    'recruitment', jsonb_build_object(
      'sub_agents_total', (SELECT count(*)::int FROM agent_subagents s WHERE s.parent_agent_id = p_agent_id),
      'sub_agents_verified', (SELECT count(*)::int FROM agent_subagents s WHERE s.parent_agent_id = p_agent_id AND s.status = 'verified'),
      'referrals_total', (SELECT count(*)::int FROM referrals r WHERE r.referrer_id = p_agent_id),
      'sub_agents', COALESCE((
        SELECT jsonb_agg(x) FROM (
          SELECT s.sub_agent_id AS id, s.status, s.created_at,
                 pr.full_name, pr.phone
            FROM agent_subagents s LEFT JOIN profiles pr ON pr.id = s.sub_agent_id
           WHERE s.parent_agent_id = p_agent_id
           ORDER BY s.created_at DESC LIMIT 25
        ) x), '[]'::jsonb)
    ),
    'listings', (
      SELECT jsonb_build_object(
        'total', count(*)::int,
        'verified', count(*) FILTER (WHERE hl.verified)::int,
        'occupied', count(*) FILTER (WHERE hl.tenant_id IS NOT NULL)::int,
        'recent', COALESCE((
          SELECT jsonb_agg(x) FROM (
            SELECT h.id, h.title, h.house_category, h.monthly_rent, h.district,
                   h.verified, h.status, h.tenant_id IS NOT NULL AS occupied, h.created_at
              FROM house_listings h WHERE h.agent_id = p_agent_id
             ORDER BY h.created_at DESC LIMIT 10
          ) x), '[]'::jsonb)
      ) FROM house_listings hl WHERE hl.agent_id = p_agent_id
    ),
    'performance', jsonb_build_object(
      'earnings_total', (SELECT COALESCE(sum(e.amount),0) FROM agent_earnings e WHERE e.agent_id = p_agent_id),
      'earnings_30d', (SELECT COALESCE(sum(e.amount),0) FROM agent_earnings e WHERE e.agent_id = p_agent_id AND e.created_at >= now() - interval '30 days'),
      'by_type', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('earning_type', t.earning_type, 'total', t.total, 'count', t.n))
          FROM (
            SELECT e.earning_type, sum(e.amount) AS total, count(*)::int AS n
              FROM agent_earnings e WHERE e.agent_id = p_agent_id
             GROUP BY e.earning_type ORDER BY sum(e.amount) DESC
          ) t), '[]'::jsonb)
    ),
    'wallet', jsonb_build_object(
      'withdrawable', COALESCE((SELECT w.withdrawable_balance FROM wallets w WHERE w.user_id = p_agent_id),0),
      'float', COALESCE((SELECT w.float_balance FROM wallets w WHERE w.user_id = p_agent_id),0),
      'advance_balance', COALESCE((SELECT w.advance_balance FROM wallets w WHERE w.user_id = p_agent_id),0),
      'advances', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', a.id, 'principal', a.principal, 'outstanding_balance', a.outstanding_balance,
          'arrears_balance', a.arrears_balance, 'daily_installment', a.daily_installment,
          'status', a.status, 'issued_at', a.issued_at, 'expires_at', a.expires_at
        ) ORDER BY a.issued_at DESC)
        FROM agent_advances a WHERE a.agent_id = p_agent_id AND a.status IN ('active','pending','overdue')
      ), '[]'::jsonb)
    ),
    'tenants', COALESCE((
      SELECT jsonb_agg(x) FROM (
        SELECT DISTINCT ON (rr.tenant_id)
               rr.tenant_id AS id, tp.full_name, tp.phone,
               rr.status, rr.rent_amount, rr.total_repayment, rr.amount_repaid,
               GREATEST(0, COALESCE(rr.total_repayment,0) - COALESCE(rr.amount_repaid,0)) AS outstanding,
               rr.agent_payment_status, rr.created_at
          FROM rent_requests rr LEFT JOIN profiles tp ON tp.id = rr.tenant_id
         WHERE rr.agent_id = p_agent_id AND rr.tenant_id IS NOT NULL AND rr.tenant_id <> rr.agent_id
         ORDER BY rr.tenant_id, rr.created_at DESC
      ) x), '[]'::jsonb)
  ) INTO v_out;

  RETURN COALESCE(v_out, '{}'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.agent_ops_directory_guard() FROM public;
GRANT EXECUTE ON FUNCTION public.get_agent_directory_v2(text,text,text,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_profile_360(uuid) TO authenticated;