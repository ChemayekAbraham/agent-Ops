CREATE OR REPLACE FUNCTION public.get_agent_service_center()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
           p.phone AS tenant_phone,
           p.city AS tenant_city,
           p.district AS tenant_district,
           p.region AS tenant_region,
           r.status,
           r.rent_amount AS monthly_rent,
           r.total_repayment,
           COALESCE(r.amount_repaid,0) AS amount_repaid,
           r.daily_repayment,
           r.landlord_id,
           r.request_city,
           (r.status IN ('funded','repaying')) AS is_active,
           true AS owned_by_subagent,
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
           p.phone AS tenant_phone,
           p.city AS tenant_city,
           p.district AS tenant_district,
           p.region AS tenant_region,
           lr.status,
           lr.rent_amount AS monthly_rent,
           lr.total_repayment,
           COALESCE(lr.amount_repaid,0) AS amount_repaid,
           lr.daily_repayment,
           lr.landlord_id,
           lr.request_city,
           (lr.status IN ('funded','repaying')) AS is_active,
           false AS owned_by_subagent,
           lr.created_at
    FROM public.profiles p
    JOIN LATERAL (
      SELECT r2.id, r2.status, r2.rent_amount, r2.total_repayment, r2.amount_repaid,
             r2.daily_repayment, r2.landlord_id, r2.request_city, r2.created_at
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
  tenant_ctx AS (
    SELECT a.*,
           ll.name AS landlord_name,
           ll.phone AS landlord_phone,
           NULLIF(btrim(concat_ws(', ',
             NULLIF(COALESCE(hl.address, ''), ''),
             NULLIF(COALESCE(hl.district, ll.district, a.tenant_district, a.tenant_city, a.request_city, ''), ''),
             NULLIF(COALESCE(hl.region, ll.region, a.tenant_region, ''), '')
           )), '') AS location
    FROM all_tenants a
    LEFT JOIN public.landlords ll ON ll.id = a.landlord_id
    LEFT JOIN LATERAL (
      SELECT h.address, h.district, h.region
      FROM public.house_listings h
      WHERE h.tenant_id = a.tenant_id
      ORDER BY h.updated_at DESC NULLS LAST
      LIMIT 1
    ) hl ON true
  ),
  tenants AS (
    SELECT a.agent_id,
           COUNT(*) FILTER (WHERE a.is_active) AS active_tenants,
           COUNT(*) AS total_tenants,
           jsonb_agg(
             jsonb_build_object(
               'rent_request_id', a.rent_request_id::text,
               'tenant_id', a.tenant_id,
               'tenant_name', a.tenant_name,
               'tenant_phone', a.tenant_phone,
               'status', a.status,
               'monthly_rent', a.monthly_rent,
               'total_repayment', a.total_repayment,
               'amount_repaid', a.amount_repaid,
               'daily_repayment', a.daily_repayment,
               'landlord_name', a.landlord_name,
               'landlord_phone', a.landlord_phone,
               'location', a.location,
               'is_active', a.is_active,
               'owned_by_subagent', a.owned_by_subagent,
               'created_at', a.created_at
             ) ORDER BY a.is_active DESC, a.created_at DESC
           ) AS tenant_list
    FROM tenant_ctx a
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
    SELECT DISTINCT ON (agent_id, landlord_id) *
    FROM (
      SELECT l.registered_by AS agent_id, l.id AS landlord_id, 'registered'::text AS link_source,
             l.name, l.phone, l.district, l.region, l.created_at,
             l.verification_status, l.verified, l.verification_reason, l.verified_at
      FROM public.landlords l
      WHERE l.registered_by IN (SELECT sub_agent_id FROM links)
      UNION ALL
      SELECT a.agent_id, l2.id AS landlord_id, 'assigned'::text AS link_source,
             l2.name, l2.phone, l2.district, l2.region, l2.created_at,
             l2.verification_status, l2.verified, l2.verification_reason, l2.verified_at
      FROM public.agent_landlord_assignments a
      JOIN public.landlords l2 ON l2.id = a.landlord_id
      WHERE a.agent_id IN (SELECT sub_agent_id FROM links)
    ) u
    ORDER BY agent_id, landlord_id, (link_source = 'registered') DESC
  ),
  land_state AS (
    SELECT u.*,
           CASE
             WHEN COALESCE(u.verified,false) OR u.verification_status = 'verified' THEN 'verified'
             WHEN u.verification_status = 'rejected' THEN 'rejected'
             ELSE 'pending'
           END AS state
    FROM land_union u
  ),
  lands AS (
    SELECT s.agent_id,
           COUNT(*) AS landlords_registered,
           COUNT(*) FILTER (WHERE s.state = 'verified') AS landlords_verified,
           COUNT(*) FILTER (WHERE s.state = 'pending') AS landlords_pending,
           COUNT(*) FILTER (WHERE s.state = 'rejected') AS landlords_rejected,
           jsonb_agg(
             jsonb_build_object(
               'id', s.landlord_id,
               'name', s.name,
               'phone', s.phone,
               'district', s.district,
               'region', s.region,
               'state', s.state,
               'link_source', s.link_source,
               'reason', s.verification_reason,
               'verified_at', s.verified_at,
               'created_at', s.created_at
             ) ORDER BY s.created_at DESC
           ) AS landlord_list
    FROM land_state s
    GROUP BY s.agent_id
  ),
  house_state AS (
    SELECT h.agent_id, h.id, h.title, h.address, h.district, h.region,
           h.monthly_rent, h.created_at, h.verified_at, h.status,
           (h.tenant_id IS NOT NULL) AS occupied,
           COALESCE(array_length(h.image_urls,1),0) AS photo_count,
           COALESCE((
             SELECT jsonb_agg(u) FROM (
               SELECT unnest(h.image_urls) AS u LIMIT 4
             ) q
           ), '[]'::jsonb) AS photos,
           CASE
             WHEN h.status = 'rejected' THEN 'rejected'
             WHEN COALESCE(h.verified,false) THEN 'verified'
             ELSE 'pending'
           END AS state,
           (SELECT r.reason FROM public.agent_listing_rejections r
             WHERE r.listing_id = h.id ORDER BY r.rejected_at DESC LIMIT 1) AS reason
    FROM public.house_listings h
    WHERE h.agent_id IN (SELECT sub_agent_id FROM links)
  ),
  houses AS (
    SELECT s.agent_id,
           COUNT(*) AS houses_listed,
           COUNT(*) FILTER (WHERE s.state = 'verified') AS houses_verified,
           COUNT(*) FILTER (WHERE s.state = 'pending') AS houses_pending,
           COUNT(*) FILTER (WHERE s.state = 'rejected') AS houses_rejected,
           jsonb_agg(
             jsonb_build_object(
               'id', s.id,
               'title', s.title,
               'address', s.address,
               'district', s.district,
               'region', s.region,
               'monthly_rent', s.monthly_rent,
               'state', s.state,
               'status', s.status,
               'occupied', s.occupied,
               'photos', s.photos,
               'photo_count', s.photo_count,
               'reason', s.reason,
               'verified_at', s.verified_at,
               'created_at', s.created_at
             ) ORDER BY s.created_at DESC
           ) AS house_list
    FROM house_state s
    GROUP BY s.agent_id
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
        'landlords_pending', COALESCE(ld.landlords_pending,0),
        'landlords_rejected', COALESCE(ld.landlords_rejected,0),
        'landlord_list', COALESCE(ld.landlord_list,'[]'::jsonb),
        'houses_listed', COALESCE(hs.houses_listed,0),
        'houses_verified', COALESCE(hs.houses_verified,0),
        'houses_pending', COALESCE(hs.houses_pending,0),
        'houses_rejected', COALESCE(hs.houses_rejected,0),
        'house_list', COALESCE(hs.house_list,'[]'::jsonb),
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
$function$;