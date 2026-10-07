CREATE OR REPLACE FUNCTION public.get_receivables_location_hierarchy(p_category text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date; v_out jsonb;
BEGIN
  PERFORM receivables_guard();
  WITH scope AS (
    SELECT
      l.counterparty_id, l.outstanding_amount AS amount, l.due_date,
      CASE WHEN vg.village_id IS NOT NULL OR da.district_id IS NOT NULL THEN 'Uganda'
           ELSE coalesce(nullif(btrim(p.country),''), 'Unknown / Unmapped Location') END AS country,
      coalesce(vg.region, da.region, 'Unknown / Unmapped Location') AS region,
      coalesce(vg.district_name, da.district_name, 'Unknown / Unmapped Location') AS district,
      coalesce(vg.subcounty_name, sa.subcounty_name, nullif(btrim(p.sub_county),''), 'Unknown / Unmapped Location') AS subcounty,
      coalesce(vg.village_name, nullif(btrim(p.village),''), 'Unknown / Unmapped Location') AS village
    FROM v_receivables_lines l
    LEFT JOIN profiles p ON p.id = l.counterparty_id
    LEFT JOIN mv_ug_village_geo vg ON vg.village_id = p.ug_village_id
    LEFT JOIN mv_ug_district_alias da ON p.ug_village_id IS NULL AND da.norm_key = ug_norm_name(nullif(p.district, ''))
    LEFT JOIN mv_ug_subcounty_alias sa ON p.ug_village_id IS NULL AND sa.district_id = da.district_id
         AND sa.norm_key = ug_norm_name(nullif(p.sub_county, ''))
    WHERE p_category IS NULL OR l.category_key = p_category
  )
  SELECT jsonb_build_object(
    'as_of', v_today,
    'total_outstanding', coalesce(round(sum(amount),2),0),
    'total_items', count(*),
    'rows', coalesce((SELECT jsonb_agg(r) FROM (
       SELECT country, region, district, subcounty, village,
              count(*) AS items, count(DISTINCT counterparty_id) AS accounts,
              round(sum(amount),2) AS outstanding,
              coalesce(round(sum(amount) FILTER (WHERE due_date < v_today),2),0) AS overdue
       FROM scope GROUP BY 1,2,3,4,5) r), '[]'::jsonb))
  INTO v_out FROM scope;
  RETURN v_out;
END $function$;
REVOKE ALL ON FUNCTION public.get_receivables_location_hierarchy(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_receivables_location_hierarchy(text) TO authenticated;