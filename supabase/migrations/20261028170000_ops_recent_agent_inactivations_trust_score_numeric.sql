-- ops_recent_agent_inactivations returns trust_score numeric, but
-- welile_trust_score_cache.score is integer. RETURN QUERY requires an
-- exact type match, so every call fails with SQLSTATE 42804
-- ("Returned type integer does not match expected type numeric in column 30").
--
-- Recreate the live function (pg_get_functiondef on byrzshwlentqvktcksem,
-- matching 20260904090000) with only column 30 changed: ts.score -> ts.score::numeric.
-- Signature, LANGUAGE, STABLE, SECURITY DEFINER, search_path and the
-- is_tenant_ops_staff check are unchanged. CREATE OR REPLACE keeps the
-- existing ACL; the REVOKE/GRANT below restates the live grants
-- (authenticated and service_role; not PUBLIC or anon).

CREATE OR REPLACE FUNCTION public.ops_recent_agent_inactivations(p_limit integer DEFAULT 25, p_since_hours integer DEFAULT 336)
 RETURNS TABLE(rent_request_id uuid, tenant_id uuid, tenant_name text, tenant_phone text, tenant_city text, agent_id uuid, agent_name text, agent_phone text, reason text, marked_at timestamp with time zone, review_status text, review_notes text, acknowledged_at timestamp with time zone, reviewer_name text, rent_amount numeric, daily_repayment numeric, total_repayment numeric, amount_repaid numeric, outstanding numeric, funded_at timestamp with time zone, days_since_funded integer, last_collection_at timestamp with time zone, last_collection_amount numeric, collections_count integer, days_since_last_collection integer, landlord_name text, landlord_phone text, house_title text, house_area text, trust_score numeric, tenancy_status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NOT public.is_tenant_ops_staff(v_uid) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  RETURN QUERY
  SELECT
    rr.id,
    rr.tenant_id,
    tp.full_name,
    tp.phone,
    tp.city,
    rr.agent_id,
    ap.full_name,
    agp.phone,
    rr.agent_payment_status_reason,
    rr.agent_payment_status_set_at,
    COALESCE(tir.status, 'open'),
    tir.notes,
    tir.acknowledged_at,
    rp.full_name,
    rr.rent_amount,
    rr.daily_repayment,
    rr.total_repayment,
    COALESCE(rr.amount_repaid, 0),
    GREATEST(COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0), 0),
    rr.funded_at,
    CASE WHEN rr.funded_at IS NOT NULL
      THEN EXTRACT(DAY FROM (now() - rr.funded_at))::int END,
    col.last_at,
    col.last_amount,
    COALESCE(col.cnt, 0)::int,
    CASE WHEN col.last_at IS NOT NULL
      THEN EXTRACT(DAY FROM (now() - col.last_at))::int END,
    lp.name,
    lp.phone,
    hl.title,
    NULLIF(concat_ws(', ', hl.district, hl.region), ''),
    ts.score::numeric,
    rr.tenancy_status
  FROM public.rent_requests rr
  LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = rr.agent_payment_status_set_by
  LEFT JOIN public.profiles agp ON agp.id = rr.agent_id
  LEFT JOIN public.landlords lp ON lp.id = rr.landlord_id
  LEFT JOIN public.house_listings hl ON hl.id = rr.house_listing_id
  LEFT JOIN public.welile_trust_score_cache ts ON ts.user_id = rr.tenant_id
  LEFT JOIN public.tenant_inactive_reviews tir ON tir.rent_request_id = rr.id
  LEFT JOIN public.profiles rp ON rp.id = COALESCE(tir.resolved_by, tir.rejected_by, tir.acknowledged_by)
  LEFT JOIN LATERAL (
    SELECT max(ac.created_at) AS last_at,
           count(*) AS cnt,
           (SELECT ac2.amount FROM public.agent_collections ac2
             WHERE ac2.tenant_id = rr.tenant_id
             ORDER BY ac2.created_at DESC LIMIT 1) AS last_amount
    FROM public.agent_collections ac
    WHERE ac.tenant_id = rr.tenant_id
  ) col ON true
  WHERE rr.agent_payment_status = 'not_paying'
    AND rr.agent_payment_status_set_at >= now() - make_interval(hours => GREATEST(p_since_hours, 1))
    AND rr.agent_payment_status_set_by IS NOT NULL
    AND rr.agent_payment_status_set_by = rr.agent_id
    AND COALESCE(tir.status, 'open') NOT IN ('resolved', 'rejected')
  ORDER BY rr.agent_payment_status_set_at DESC
  LIMIT GREATEST(LEAST(p_limit, 100), 1);
END;
$function$;

REVOKE ALL ON FUNCTION public.ops_recent_agent_inactivations(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_recent_agent_inactivations(integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_recent_agent_inactivations(integer, integer) TO service_role;
