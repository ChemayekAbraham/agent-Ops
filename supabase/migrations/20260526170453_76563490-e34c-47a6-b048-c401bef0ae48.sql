CREATE OR REPLACE FUNCTION public.get_tenants_at_leaf(
  p_country text, p_region text, p_district text, p_ward text,
  p_agent_id uuid, p_landlord_id uuid,
  p_limit integer DEFAULT 300,
  p_funded_since timestamptz DEFAULT NULL,
  p_funded_until timestamptz DEFAULT NULL,
  p_outstanding text DEFAULT NULL,
  p_verification text DEFAULT NULL,
  p_funding_source text DEFAULT NULL
)
RETURNS TABLE(
  tenant_id uuid, tenant_name text, tenant_phone text, tenant_avatar_url text,
  tenant_photo_url text, house_image_urls text[], house_category text,
  rent_amount numeric, rent_request_id uuid,
  agent_id uuid, agent_name text, landlord_id uuid, landlord_name text,
  country text, region text, district text, ward text,
  landlord_funded_at timestamptz, landlord_funded_amount bigint, landlord_payout_count integer,
  outstanding_status text, verification_status text, funding_source text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH payouts AS (
    SELECT lp.tenant_id,
           MAX(lp.disbursed_at) AS funded_at,
           COALESCE(SUM(lp.amount) FILTER (WHERE lp.disbursed_at IS NOT NULL), 0)::bigint AS funded_amount,
           COUNT(*) FILTER (WHERE lp.disbursed_at IS NOT NULL)::int AS payout_count
    FROM landlord_payouts lp
    WHERE lp.tenant_id IS NOT NULL
    GROUP BY lp.tenant_id
  ),
  rr AS (
    SELECT DISTINCT ON (r.tenant_id)
           r.tenant_id,
           r.supporter_id,
           r.total_repayment,
           r.amount_repaid,
           r.tenancy_status,
           r.outstanding_at_end,
           r.disbursed_at
    FROM rent_requests r
    WHERE r.tenant_id IS NOT NULL
    ORDER BY r.tenant_id, r.disbursed_at DESC NULLS LAST, r.created_at DESC
  ),
  base AS (
    SELECT
      t.tenant_id, t.tenant_name, t.tenant_phone, t.tenant_avatar_url,
      t.tenant_photo_url, t.house_image_urls, t.house_category, t.rent_amount, t.rent_request_id,
      t.agent_id, pa.full_name AS agent_name, t.landlord_id, pl.full_name AS landlord_name,
      t.country, t.region, t.district, t.ward,
      po.funded_at AS landlord_funded_at,
      COALESCE(po.funded_amount, 0)::bigint AS landlord_funded_amount,
      COALESCE(po.payout_count, 0)::int AS landlord_payout_count,
      CASE
        WHEN rr.tenancy_status IN ('ended','defaulted') AND COALESCE(rr.outstanding_at_end,0) > 0 THEN 'defaulted'
        WHEN rr.total_repayment IS NULL OR rr.total_repayment <= 0 THEN 'partial'
        WHEN COALESCE(rr.amount_repaid,0) >= rr.total_repayment THEN 'paid_up'
        WHEN COALESCE(rr.amount_repaid,0) <= 0 AND rr.disbursed_at IS NOT NULL AND rr.disbursed_at < now() - interval '30 days' THEN 'overdue'
        WHEN COALESCE(rr.amount_repaid,0) > 0 THEN 'partial'
        ELSE 'overdue'
      END AS outstanding_status,
      CASE
        WHEN ts.ai_id IS NOT NULL AND length(ts.ai_id) > 0 THEN 'verified'
        WHEN ts.user_id IS NOT NULL THEN 'pending'
        ELSE 'missing'
      END AS verification_status,
      CASE
        WHEN rr.supporter_id IS NOT NULL THEN 'supporter'
        ELSE 'platform'
      END AS funding_source
    FROM v_tenant_location_pivot t
    LEFT JOIN profiles pa ON pa.id = t.agent_id
    LEFT JOIN profiles pl ON pl.id = t.landlord_id
    LEFT JOIN payouts  po ON po.tenant_id = t.tenant_id
    LEFT JOIN rr        ON rr.tenant_id = t.tenant_id
    LEFT JOIN welile_trust_score_cache ts ON ts.user_id = t.tenant_id
    WHERE t.country  = p_country
      AND t.region   = p_region
      AND t.district = p_district
      AND t.ward     = p_ward
      AND (t.agent_id    = p_agent_id    OR (p_agent_id    IS NULL AND t.agent_id    IS NULL))
      AND (t.landlord_id = p_landlord_id OR (p_landlord_id IS NULL AND t.landlord_id IS NULL))
      AND (p_funded_since IS NULL OR po.funded_at >= p_funded_since)
      AND (p_funded_until IS NULL OR po.funded_at <  p_funded_until)
  )
  SELECT * FROM base
  WHERE (p_outstanding     IS NULL OR outstanding_status   = p_outstanding)
    AND (p_verification    IS NULL OR verification_status  = p_verification)
    AND (p_funding_source  IS NULL OR funding_source       = p_funding_source)
  ORDER BY tenant_name NULLS LAST
  LIMIT GREATEST(p_limit, 1);
$function$;