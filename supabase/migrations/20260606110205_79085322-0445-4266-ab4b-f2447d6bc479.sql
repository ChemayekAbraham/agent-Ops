CREATE OR REPLACE FUNCTION public.welile_mission_receivables(p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(placed_receivable_total numeric, placed_receivable_count bigint, empty_receivable_total numeric, empty_houses_count bigint, unlisted_receivable_total numeric, unlisted_landlord_count bigint, known_rent_count bigint, missing_rent_count bigint, avg_known_monthly numeric, estimated_full_total numeric, earliest_date timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_earliest timestamptz;
  v_known_total numeric;
  v_known_count bigint;
  v_missing_count bigint;
  v_avg_monthly numeric;
BEGIN
  IF NOT public.is_ops_role(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT LEAST(
    (SELECT MIN(created_at) FROM public.house_listings WHERE tenant_id IS NULL AND status <> 'rejected' AND COALESCE(is_hidden, false) = false),
    (SELECT MIN(created_at) FROM public.landlords l
     WHERE l.registered_by IS NOT NULL
       AND l.tenant_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.house_listings h WHERE h.landlord_id = l.id))
  ) INTO v_earliest;

  -- Projection formula per house: ((rent + 33% of rent) / 30) * 30 * 12 = rent * 1.33 * 12

  -- Window-scoped pool: drives the in-window known total + counts.
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
    COUNT(*) FILTER (WHERE rent <= 0)
  INTO v_known_total, v_known_count, v_missing_count
  FROM pool;

  -- Global average known rent (NOT window-scoped) so narrow windows
  -- (e.g. 1 day) can still estimate missing rents instead of collapsing to 0.
  WITH global_pool AS (
    SELECT COALESCE(monthly_rent, 0) AS rent
    FROM public.house_listings
    WHERE tenant_id IS NULL AND status <> 'rejected' AND COALESCE(is_hidden, false) = false
    UNION ALL
    SELECT COALESCE(l.monthly_rent, l.desired_rent_from_welile, 0) AS rent
    FROM public.landlords l
    WHERE l.registered_by IS NOT NULL
      AND l.tenant_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.house_listings h WHERE h.landlord_id = l.id)
  )
  SELECT COALESCE(AVG(rent) FILTER (WHERE rent > 0), 0)
  INTO v_avg_monthly
  FROM global_pool;

  RETURN QUERY
  SELECT
    -- PLACED: houses that now have a tenant assigned (same projection formula)
    COALESCE((SELECT SUM(((monthly_rent * 1.33) / 30) * 30 * 12) FROM public.house_listings
              WHERE tenant_id IS NOT NULL AND status <> 'rejected'
                AND (p_since IS NULL OR created_at >= p_since)), 0)::numeric,
    COALESCE((SELECT COUNT(*) FROM public.house_listings
              WHERE tenant_id IS NOT NULL AND status <> 'rejected'
                AND (p_since IS NULL OR created_at >= p_since)), 0)::bigint,
    -- EMPTY: listed houses with no tenant yet
    COALESCE((SELECT SUM(((monthly_rent * 1.33) / 30) * 30 * 12) FROM public.house_listings
              WHERE tenant_id IS NULL AND status <> 'rejected' AND COALESCE(is_hidden, false) = false
                AND (p_since IS NULL OR created_at >= p_since)), 0)::numeric,
    COALESCE((SELECT COUNT(*) FROM public.house_listings
              WHERE tenant_id IS NULL AND status <> 'rejected' AND COALESCE(is_hidden, false) = false
                AND (p_since IS NULL OR created_at >= p_since)), 0)::bigint,
    -- UNLISTED landlords with vacant houses
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
    (v_known_total + (v_missing_count * (((v_avg_monthly * 1.33) / 30) * 30 * 12)))::numeric,
    v_earliest;
END;
$function$;