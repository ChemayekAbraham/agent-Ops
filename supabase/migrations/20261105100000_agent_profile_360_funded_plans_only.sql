-- Agent profile (Agent Ops directory): the Tenants tab and the repayment totals counted every
-- Rent Plan an agent ever submitted, including rejected, deleted and still-pending ones. A rejected
-- plan was listed as "paying" with its whole total as Outstanding although no money was disbursed.
--
-- Only plans that were actually funded count: funded, repaying, active, completed, closed.
-- Everything else in this function is unchanged from the live definition.
-- CREATE OR REPLACE keeps the existing grants.

CREATE OR REPLACE FUNCTION public.get_agent_profile_360(p_agent_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      ) FROM rent_requests rr
       WHERE rr.agent_id = p_agent_id
         AND rr.status IN ('funded','repaying','active','completed','closed')
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
              FROM (SELECT * FROM public.agent_collections WHERE reversed_at IS NULL) c WHERE c.agent_id = p_agent_id
             ORDER BY c.created_at DESC LIMIT 10
          ) x), '[]'::jsonb)
      ) FROM (SELECT * FROM public.agent_collections WHERE reversed_at IS NULL) ac WHERE ac.agent_id = p_agent_id
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
           AND rr.status IN ('funded','repaying','active','completed','closed')
         ORDER BY rr.tenant_id, rr.created_at DESC
      ) x), '[]'::jsonb)
  ) INTO v_out;

  RETURN COALESCE(v_out, '{}'::jsonb);
END;
$function$;
