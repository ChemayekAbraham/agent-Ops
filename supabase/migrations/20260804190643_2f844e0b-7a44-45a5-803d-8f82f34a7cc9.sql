CREATE OR REPLACE FUNCTION public.get_agent_service_center()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_parent uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  WITH links AS (
    SELECT s.sub_agent_id, s.status AS link_status, s.created_at AS linked_at, s.source
    FROM public.agent_subagents s
    WHERE s.parent_agent_id = v_parent
      AND s.status IN ('verified','pending_acceptance')
  ),
  earn AS (
    SELECT e.agent_id,
           COALESCE(SUM(CASE WHEN e.earning_type ILIKE '%referral%' OR e.earning_type ILIKE '%bonus%' THEN e.amount ELSE 0 END),0) AS referral_bonus,
           COALESCE(SUM(CASE WHEN NOT (e.earning_type ILIKE '%referral%' OR e.earning_type ILIKE '%bonus%') THEN e.amount ELSE 0 END),0) AS commission_total
    FROM public.agent_earnings e
    WHERE e.agent_id IN (SELECT sub_agent_id FROM links)
    GROUP BY e.agent_id
  ),
  accrual AS (
    SELECT c.agent_id, COALESCE(SUM(c.amount),0) AS commission_total
    FROM public.commission_accrual_ledger c
    WHERE c.agent_id IN (SELECT sub_agent_id FROM links)
      AND COALESCE(c.status,'') <> 'rejected'
    GROUP BY c.agent_id
  ),
  rr AS (
    SELECT r.agent_id,
           r.id AS rent_request_id,
           r.tenant_id,
           p.full_name AS tenant_name,
           r.status,
           r.rent_amount AS monthly_rent,
           (r.status IN ('funded','repaying')) AS is_active,
           r.created_at
    FROM public.rent_requests r
    LEFT JOIN public.profiles p ON p.id = r.tenant_id
    WHERE r.agent_id IN (SELECT sub_agent_id FROM links)
      AND r.status NOT IN ('deleted_by_agent')
  ),
  referred AS (
    SELECT p.referrer_id AS agent_id,
           lr.id AS rent_request_id,
           p.id AS tenant_id,
           p.full_name AS tenant_name,
           COALESCE(lr.status, 'no_rent_plan') AS status,
           lr.rent_amount AS monthly_rent,
           COALESCE(lr.status IN ('funded','repaying'), false) AS is_active,
           p.created_at
    FROM public.profiles p
    LEFT JOIN LATERAL (
      SELECT r2.id, r2.status, r2.rent_amount
      FROM public.rent_requests r2
      WHERE r2.tenant_id = p.id
        AND r2.status NOT IN ('deleted_by_agent')
      ORDER BY (r2.status IN ('funded','repaying')) DESC, r2.created_at DESC
      LIMIT 1
    ) lr ON true
    WHERE p.referrer_id IN (SELECT sub_agent_id FROM links)
      AND NOT EXISTS (
        SELECT 1 FROM rr WHERE rr.tenant_id = p.id AND rr.agent_id = p.referrer_id
      )
  ),
  all_tenants AS (
    SELECT * FROM rr
    UNION ALL
    SELECT * FROM referred
  ),
  tenants AS (
    SELECT a.agent_id,
           COUNT(*) FILTER (WHERE a.is_active) AS active_tenants,
           COUNT(*) AS total_tenants,
           jsonb_agg(
             jsonb_build_object(
               'rent_request_id', COALESCE(a.rent_request_id::text, 'profile:' || a.tenant_id::text),
               'tenant_id', a.tenant_id,
               'tenant_name', a.tenant_name,
               'status', a.status,
               'monthly_rent', a.monthly_rent,
               'is_active', a.is_active
             ) ORDER BY a.is_active DESC, a.created_at DESC
           ) AS tenant_list
    FROM all_tenants a
    GROUP BY a.agent_id
  ),
  nested AS (
    SELECT s.parent_agent_id AS agent_id, COUNT(*) AS nested_subagents
    FROM public.agent_subagents s
    WHERE s.parent_agent_id IN (SELECT sub_agent_id FROM links)
      AND s.status = 'verified'
    GROUP BY s.parent_agent_id
  ),
  land_union AS (
    SELECT l.registered_by AS agent_id, l.id AS landlord_id,
           (l.verification_status = 'verified' OR l.verified) AS is_verified
    FROM public.landlords l
    WHERE l.registered_by IN (SELECT sub_agent_id FROM links)
    UNION
    SELECT a.agent_id, l2.id AS landlord_id,
           (l2.verification_status = 'verified' OR l2.verified) AS is_verified
    FROM public.agent_landlord_assignments a
    JOIN public.landlords l2 ON l2.id = a.landlord_id
    WHERE a.agent_id IN (SELECT sub_agent_id FROM links)
  ),
  lands AS (
    SELECT u.agent_id,
           COUNT(DISTINCT u.landlord_id) AS landlords_registered,
           COUNT(DISTINCT u.landlord_id) FILTER (WHERE u.is_verified) AS landlords_verified
    FROM land_union u
    GROUP BY u.agent_id
  ),
  houses AS (
    SELECT h.agent_id,
           COUNT(*) AS houses_listed,
           COUNT(*) FILTER (WHERE COALESCE(h.verified,false)) AS houses_verified
    FROM public.house_listings h
    WHERE h.agent_id IN (SELECT sub_agent_id FROM links)
    GROUP BY h.agent_id
  ),
  blocks AS (
    SELECT b.agent_id, b.blocked_until, b.reason, b.freeze_scope
    FROM public.agent_listing_blocks b
    WHERE b.agent_id IN (SELECT sub_agent_id FROM links)
      AND b.active
      AND (b.blocked_until IS NULL OR b.blocked_until > now())
  ),
  pending_tf AS (
    SELECT t.from_sub_agent_id AS agent_id, COUNT(*) AS pending_transfers
    FROM public.subagent_tenant_transfers t
    WHERE t.parent_agent_id = v_parent AND t.status = 'pending'
    GROUP BY t.from_sub_agent_id
  )
  SELECT jsonb_build_object(
    'parent_agent_id', v_parent,
    'generated_at', now(),
    'sub_agents', COALESCE(jsonb_agg(
      jsonb_build_object(
        'sub_agent_id', k.sub_agent_id,
        'full_name', pr.full_name,
        'avatar_url', pr.avatar_url,
        'phone', pr.phone,
        'email', pr.email,
        'agent_tier', pr.agent_tier,
        'link_status', k.link_status,
        'linked_at', k.linked_at,
        'source', k.source,
        'commission_total', GREATEST(COALESCE(ac.commission_total,0), COALESCE(e.commission_total,0)),
        'referral_bonus', COALESCE(e.referral_bonus,0),
        'active_tenants', COALESCE(t.active_tenants,0),
        'total_tenants', COALESCE(t.total_tenants,0),
        'tenant_list', COALESCE(t.tenant_list,'[]'::jsonb),
        'nested_subagents', COALESCE(n.nested_subagents,0),
        'landlords_registered', COALESCE(ld.landlords_registered,0),
        'landlords_verified', COALESCE(ld.landlords_verified,0),
        'houses_listed', COALESCE(hs.houses_listed,0),
        'houses_verified', COALESCE(hs.houses_verified,0),
        'wallet', jsonb_build_object(
          'withdrawable', COALESCE(w.withdrawable_balance,0),
          'float', COALESCE(w.float_balance,0),
          'advance', COALESCE(w.advance_balance,0)
        ),
        'suspension', CASE WHEN b.agent_id IS NULL THEN NULL ELSE jsonb_build_object(
          'blocked_until', b.blocked_until,
          'reason', b.reason,
          'scope', b.freeze_scope
        ) END,
        'pending_transfers', COALESCE(ptf.pending_transfers,0)
      ) ORDER BY pr.full_name NULLS LAST
    ), '[]'::jsonb)
  )
  INTO v_result
  FROM links k
  LEFT JOIN public.profiles pr ON pr.id = k.sub_agent_id
  LEFT JOIN earn e ON e.agent_id = k.sub_agent_id
  LEFT JOIN accrual ac ON ac.agent_id = k.sub_agent_id
  LEFT JOIN tenants t ON t.agent_id = k.sub_agent_id
  LEFT JOIN nested n ON n.agent_id = k.sub_agent_id
  LEFT JOIN lands ld ON ld.agent_id = k.sub_agent_id
  LEFT JOIN houses hs ON hs.agent_id = k.sub_agent_id
  LEFT JOIN blocks b ON b.agent_id = k.sub_agent_id
  LEFT JOIN pending_tf ptf ON ptf.agent_id = k.sub_agent_id
  LEFT JOIN public.wallets w ON w.user_id = k.sub_agent_id;

  RETURN COALESCE(v_result, jsonb_build_object('parent_agent_id', v_parent, 'sub_agents', '[]'::jsonb));
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.get_agent_service_center() TO authenticated;