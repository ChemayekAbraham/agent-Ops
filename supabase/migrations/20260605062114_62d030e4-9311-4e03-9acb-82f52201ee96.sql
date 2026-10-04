DROP FUNCTION IF EXISTS public.welile_mission_receivables(timestamp with time zone);

CREATE OR REPLACE FUNCTION public.welile_mission_receivables(p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(
   placed_receivable_total numeric,
   placed_receivable_count bigint,
   empty_receivable_total numeric,
   empty_houses_count bigint,
   unlisted_receivable_total numeric,
   unlisted_landlord_count bigint,
   known_rent_count bigint,
   missing_rent_count bigint,
   avg_known_monthly numeric,
   estimated_full_total numeric,
   earliest_date timestamp with time zone
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_earliest timestamptz;
  v_known_total numeric;     -- annual receivable from houses WITH a rent value (33% marked up)
  v_known_count bigint;      -- houses with rent > 0
  v_missing_count bigint;    -- houses with no/zero rent
  v_avg_monthly numeric;     -- average monthly rent across known houses
BEGIN
  IF NOT public.is_ops_role(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- earliest date across empty listings and unlisted landlords
  SELECT LEAST(
    (SELECT MIN(created_at) FROM public.house_listings WHERE tenant_id IS NULL AND status <> 'rejected' AND COALESCE(is_hidden, false) = false),
    (SELECT MIN(created_at) FROM public.landlords l
     WHERE l.registered_by IS NOT NULL
       AND l.tenant_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.house_listings h WHERE h.landlord_id = l.id))
  ) INTO v_earliest;

  -- Projection formula per house: ((rent + 33% of rent) / 30 days) * 30 days * 12 months
  -- = rent * 1.33 * 12 (annual projected receivable with 33% markup)

  -- unified pool of empty units (listed + unlisted) with their monthly rent
  WITH pool AS (
    SELECT COALESCE(monthly_rent, 0) AS rent
    FROM public.house_listings
    WHERE tenant_id IS NULL AND status <> 'rejected' AND COALESCE(is_hidden, false) = false
      AND (p_since IS NULL OR created_at >= p_since)
    UNION ALL
    SELECT COALESCE(l.monthly_rent, l.desired_rent_from_welile, 0) AS rent
    FROM public.landlords l
    WHERE l.registered_by IS NOT NULL
      AND l.tenant_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.house_listings h WHERE h.landlord_id = l.id)
      AND (p_since IS NULL OR l.created_at >= p_since)
  )
  SELECT
    COALESCE(SUM(((rent * 1.33) / 30) * 30 * 12) FILTER (WHERE rent > 0), 0),
    COUNT(*) FILTER (WHERE rent > 0),
    COUNT(*) FILTER (WHERE rent <= 0),
    COALESCE(AVG(rent) FILTER (WHERE rent > 0), 0)
  INTO v_known_total, v_known_count, v_missing_count, v_avg_monthly
  FROM pool;

  RETURN QUERY
  SELECT
    COALESCE((SELECT SUM(amount) FROM public.landlord_account_ledger WHERE entry_type = 'receivable'), 0)::numeric,
    COALESCE((SELECT COUNT(*) FROM public.landlord_account_ledger WHERE entry_type = 'receivable'), 0)::bigint,
    COALESCE((SELECT SUM(((monthly_rent * 1.33) / 30) * 30 * 12) FROM public.house_listings
              WHERE tenant_id IS NULL AND status <> 'rejected' AND COALESCE(is_hidden, false) = false
                AND (p_since IS NULL OR created_at >= p_since)), 0)::numeric,
    COALESCE((SELECT COUNT(*) FROM public.house_listings
              WHERE tenant_id IS NULL AND status <> 'rejected' AND COALESCE(is_hidden, false) = false
                AND (p_since IS NULL OR created_at >= p_since)), 0)::bigint,
    COALESCE((SELECT SUM(((COALESCE(l.monthly_rent, l.desired_rent_from_welile, 0) * 1.33) / 30) * 30 * 12)
              FROM public.landlords l
              WHERE l.registered_by IS NOT NULL
                AND l.tenant_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM public.house_listings h WHERE h.landlord_id = l.id)
                AND (p_since IS NULL OR l.created_at >= p_since)), 0)::numeric,
    COALESCE((SELECT COUNT(*)
              FROM public.landlords l
              WHERE l.registered_by IS NOT NULL
                AND l.tenant_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM public.house_listings h WHERE h.landlord_id = l.id)
                AND (p_since IS NULL OR l.created_at >= p_since)), 0)::bigint,
    v_known_count,
    v_missing_count,
    v_avg_monthly,
    -- Estimated full potential: known (already marked up) + missing houses filled at avg rent, also 33% marked up
    (v_known_total + (v_missing_count * (((v_avg_monthly * 1.33) / 30) * 30 * 12)))::numeric,
    v_earliest;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.welile_mission_receivables(timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.welile_mission_receivables(timestamp with time zone) TO service_role;