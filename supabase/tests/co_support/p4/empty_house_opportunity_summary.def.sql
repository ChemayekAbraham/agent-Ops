CREATE OR REPLACE FUNCTION public.empty_house_opportunity_summary(p_quote_for text DEFAULT 'public'::text, p_partner_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH quote AS MATERIALIZED (SELECT public.partner_quote_rate(p_quote_for, p_partner_id) AS rate),
base AS (
  SELECT h.id, COALESCE(h.monthly_rent, 0) AS rent,
         NULLIF(TRIM(COALESCE(h.district, '')), '') AS district,
         h.landlord_id,
         (
           EXISTS (SELECT 1 FROM public.promissory_note_house_intents i
                    WHERE i.house_id = h.id AND i.status IN ('reserved','funded'))
           OR EXISTS (SELECT 1 FROM public.partner_supported_houses psh
                       WHERE psh.house_id = h.id AND psh.status IN ('pending','active'))
           OR EXISTS (SELECT 1 FROM public.portfolio_allocations a
                       WHERE a.house_id = h.id AND a.status IN ('reserved','fulfilled'))
         ) AS is_funded
  FROM public.house_listings h
  WHERE h.status = 'available'
    AND h.tenant_id IS NULL
    AND COALESCE(h.is_hidden, false) = false
    AND COALESCE(h.monthly_rent, 0) > 0
),
avail AS (SELECT * FROM base WHERE NOT is_funded),
districts AS (
  SELECT jsonb_agg(d ORDER BY (d->>'total_rent_needed')::numeric DESC) AS rows
  FROM (SELECT jsonb_build_object('district', COALESCE(district,'Unspecified'),
          'house_count', COUNT(*), 'total_rent_needed', COALESCE(SUM(rent),0),
          'monthly_return', COALESCE(SUM(ROUND(rent*((SELECT q.rate FROM quote q) / 100))),0)) AS d
        FROM avail GROUP BY COALESCE(district,'Unspecified')
        ORDER BY SUM(rent) DESC LIMIT 12) t
),
landlords AS (
  SELECT jsonb_agg(l ORDER BY (l->>'total_rent_needed')::numeric DESC) AS rows
  FROM (SELECT jsonb_build_object('landlord_name', TRIM(p.name),
          'house_count', COUNT(*), 'total_rent_needed', COALESCE(SUM(a.rent),0),
          'monthly_return', COALESCE(SUM(ROUND(a.rent*((SELECT q.rate FROM quote q) / 100))),0)) AS l
        FROM avail a JOIN public.landlords p ON p.id = a.landlord_id
        WHERE NULLIF(TRIM(COALESCE(p.name,'')),'') IS NOT NULL
        GROUP BY TRIM(p.name) ORDER BY SUM(a.rent) DESC LIMIT 8) t
)
SELECT jsonb_build_object(
  'house_count', (SELECT COUNT(*) FROM avail),
  'total_rent_needed', (SELECT COALESCE(SUM(rent),0) FROM avail),
  'monthly_return_if_all_funded', (SELECT COALESCE(SUM(ROUND(rent*((SELECT q.rate FROM quote q) / 100))),0) FROM avail),
  'avg_monthly_rent', (SELECT COALESCE(ROUND(AVG(rent)),0) FROM avail),
  'funded_count', (SELECT COUNT(*) FROM base WHERE is_funded),
  'funded_rent', (SELECT COALESCE(SUM(rent),0) FROM base WHERE is_funded),
  'total_listed', (SELECT COUNT(*) FROM base),
  'districts', COALESCE((SELECT rows FROM districts),'[]'::jsonb),
  'landlords', COALESCE((SELECT rows FROM landlords),'[]'::jsonb),
  'returns_rate_pct', (SELECT q.rate FROM quote q));
$function$
