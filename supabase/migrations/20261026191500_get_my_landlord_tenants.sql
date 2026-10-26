-- Landlord "My Tenants" page: the signed-in landlord's tenants and their Rent Plans.
--
-- A landlord's login is tied to their landlord records by phone number (the same rule as
-- get_my_landlord_properties). rent_requests.landlord_id points at landlords.id, and no
-- row-level rule lets a landlord read rent_requests, so the page cannot query it directly;
-- this SECURITY DEFINER function returns only what a landlord should see:
--   * the tenant's name and phone, and the property,
--   * each Rent Plan's status, rent amount, duration and dates,
--   * repayment progress as a percentage (not the tenant's fee or repayment amounts).
-- Rejected, cancelled and deleted requests are left out.

CREATE OR REPLACE FUNCTION public.get_my_landlord_tenants()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_phone text;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  SELECT phone INTO v_phone FROM public.profiles WHERE id = v_uid;

  IF v_phone IS NULL OR length(regexp_replace(v_phone, '\D', '', 'g')) < 9 THEN
    RETURN jsonb_build_object('matched_by_phone', false, 'plans', '[]'::jsonb);
  END IF;

  WITH q AS (
    SELECT regexp_replace(v_phone, '\D', '', 'g') AS digits
  ), n AS (
    SELECT
      digits,
      CASE WHEN digits LIKE '256%' AND length(digits) >= 12 THEN '0' || substr(digits, 4) ELSE digits END AS local_digits,
      CASE WHEN digits LIKE '0%' AND length(digits) >= 10 THEN '256' || substr(digits, 2) ELSE digits END AS intl_digits
    FROM q
  ),
  mine AS (
    SELECT l.id, l.property_address, l.house_category
    FROM public.landlords l, n
    WHERE regexp_replace(COALESCE(l.phone, ''), '\D', '', 'g') IN (n.digits, n.local_digits, n.intl_digits)
  ),
  plans AS (
    SELECT
      r.id,
      r.tenant_id,
      r.status,
      r.tenancy_status,
      r.rent_amount,
      r.duration_days,
      r.created_at,
      r.funded_at,
      r.repayment_starts_on,
      CASE WHEN COALESCE(r.total_repayment, 0) > 0
           THEN round(LEAST(100, GREATEST(0, COALESCE(r.amount_repaid, 0) * 100 / r.total_repayment)))
           ELSE 0 END AS progress_pct,
      (COALESCE(r.repayment_starts_on, r.funded_at::date, r.created_at::date)
         + COALESCE(r.duration_days, 0)) AS ends_on,
      m.property_address,
      m.house_category
    FROM public.rent_requests r
    JOIN mine m ON m.id = r.landlord_id
    WHERE r.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent')
    ORDER BY COALESCE(r.funded_at, r.created_at) DESC
    LIMIT 500
  )
  SELECT jsonb_build_object(
    'matched_by_phone', true,
    'landlord_records', (SELECT count(*) FROM mine),
    'plans', COALESCE(jsonb_agg(jsonb_build_object(
      'id', p.id,
      'tenant_id', p.tenant_id,
      'tenant_name', CASE WHEN t.full_name ILIKE '[DELETED]%' THEN 'Former tenant'
                          ELSE COALESCE(NULLIF(btrim(t.full_name), ''), 'Tenant') END,
      'tenant_phone', CASE WHEN t.full_name ILIKE '[DELETED]%' THEN NULL ELSE t.phone END,
      'status', p.status,
      'tenancy_status', p.tenancy_status,
      'rent_amount', p.rent_amount,
      'duration_days', p.duration_days,
      'created_at', p.created_at,
      'funded_at', p.funded_at,
      'starts_on', COALESCE(p.repayment_starts_on, p.funded_at::date),
      'ends_on', p.ends_on,
      'progress_pct', p.progress_pct,
      'property_address', p.property_address,
      'house_category', p.house_category
    ) ORDER BY COALESCE(p.funded_at, p.created_at) DESC), '[]'::jsonb)
  ) INTO v_result
  FROM plans p
  LEFT JOIN public.profiles t ON t.id = p.tenant_id;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_my_landlord_tenants() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_landlord_tenants() TO authenticated, service_role;
