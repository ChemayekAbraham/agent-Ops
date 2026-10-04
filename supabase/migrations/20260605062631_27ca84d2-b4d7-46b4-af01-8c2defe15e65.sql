CREATE OR REPLACE FUNCTION public.welile_receivables_audit(p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 12)
 RETURNS TABLE(
   src text,
   unit_id text,
   label text,
   region text,
   monthly_rent numeric,
   rent_plus_markup numeric,
   daily_projected numeric,
   annual_projection numeric,
   rent_bucket text
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_ops_role(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  WITH pool AS (
    SELECT
      'listing'::text AS src,
      h.id::text AS unit_id,
      COALESCE(NULLIF(h.title, ''), 'Listing') AS label,
      COALESCE(h.region, h.district, '—') AS region,
      COALESCE(h.monthly_rent, 0) AS rent
    FROM public.house_listings h
    WHERE h.tenant_id IS NULL AND h.status <> 'rejected' AND COALESCE(h.is_hidden, false) = false
      AND (p_since IS NULL OR h.created_at >= p_since)
    UNION ALL
    SELECT
      'landlord'::text AS src,
      l.id::text AS unit_id,
      COALESCE(NULLIF(l.name, ''), 'Unlisted landlord') AS label,
      COALESCE(l.region, l.district, '—') AS region,
      COALESCE(l.monthly_rent, l.desired_rent_from_welile, 0) AS rent
    FROM public.landlords l
    WHERE l.registered_by IS NOT NULL
      AND l.tenant_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.house_listings h WHERE h.landlord_id = l.id)
      AND (p_since IS NULL OR l.created_at >= p_since)
  )
  SELECT
    p.src,
    p.unit_id,
    p.label,
    p.region,
    p.rent,
    round(p.rent * 1.33, 2),
    round((p.rent * 1.33) / 30, 2),
    round(((p.rent * 1.33) / 30) * 30 * 12, 2),
    CASE WHEN p.rent > 0 THEN 'recorded' ELSE 'missing' END
  FROM pool p
  ORDER BY (p.rent > 0) DESC, p.rent DESC
  LIMIT GREATEST(p_limit, 1);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.welile_receivables_audit(timestamp with time zone, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.welile_receivables_audit(timestamp with time zone, integer) TO service_role;