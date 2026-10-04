CREATE OR REPLACE FUNCTION public.get_location_reconciliation_report(p_rollout_from date DEFAULT '2026-08-11')
RETURNS TABLE (
  table_label text,
  scope_label text,
  total_rows bigint,
  resolved_rows bigint,
  unmatched_rows bigint,
  resolved_pct numeric,
  new_total_rows bigint,
  new_resolved_rows bigint,
  top_unmatched jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT (
    public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'manager')
    OR public.has_role(v_uid, 'ceo') OR public.has_role(v_uid, 'coo') OR public.has_role(v_uid, 'cfo')
    OR public.has_role(v_uid, 'cto') OR public.has_role(v_uid, 'operations')
    OR public.has_role(v_uid, 'tenant_ops') OR public.has_role(v_uid, 'landlord_ops')
    OR public.has_role(v_uid, 'agent_ops') OR public.has_role(v_uid, 'financial_ops')
    OR public.has_role(v_uid, 'partner_ops') OR public.has_role(v_uid, 'access_admin')
  ) THEN
    RAISE EXCEPTION 'not authorized to read the location reconciliation report';
  END IF;

  RETURN QUERY
  WITH d AS (SELECT public.ug_norm_name(name) AS n FROM public.ug_districts),
  src AS (
    SELECT 'house_listings'::text AS tbl, 'village / district'::text AS scope,
           (h.ug_village_id IS NOT NULL) AS by_id, h.district AS txt, h.created_at
      FROM public.house_listings h
    UNION ALL
    SELECT 'profiles', 'residence village / district',
           (p.ug_village_id IS NOT NULL), p.district, p.created_at
      FROM public.profiles p
     WHERE COALESCE(p.district, p.village, p.ug_village_id::text) IS NOT NULL
    UNION ALL
    SELECT 'landlords', 'village / district',
           (l.ug_village_id IS NOT NULL), l.district, l.created_at
      FROM public.landlords l
    UNION ALL
    SELECT 'lc1_chairpersons', 'village / district',
           (c.ug_village_id IS NOT NULL), c.district, c.created_at
      FROM public.lc1_chairpersons c
    UNION ALL
    SELECT 'managed_locations', 'district (+ finer units)',
           (m.ug_district_id IS NOT NULL), m.district, m.created_at
      FROM public.managed_locations m
    UNION ALL
    SELECT 'recruitment_locations', 'district',
           (r.ug_district_id IS NOT NULL), r.district, r.created_at
      FROM public.recruitment_locations r
    UNION ALL
    SELECT 'service_center_requests', 'district',
           (s.ug_district_id IS NOT NULL), s.district, s.created_at
      FROM public.service_center_requests s
  ),
  flagged AS (
    SELECT src.*,
           (src.by_id OR EXISTS (SELECT 1 FROM d WHERE d.n = public.ug_norm_name(src.txt))) AS resolved
      FROM src
  ),
  agg AS (
    SELECT tbl, scope,
           count(*) AS total,
           count(*) FILTER (WHERE resolved) AS res,
           count(*) FILTER (WHERE created_at >= p_rollout_from) AS new_total,
           count(*) FILTER (WHERE created_at >= p_rollout_from AND resolved) AS new_res
      FROM flagged GROUP BY tbl, scope
  ),
  top_bad AS (
    SELECT tbl,
           jsonb_agg(jsonb_build_object('value', COALESCE(v, '(blank)'), 'rows', c) ORDER BY c DESC) AS items
      FROM (
        SELECT tbl, NULLIF(btrim(txt), '') AS v, count(*) AS c,
               row_number() OVER (PARTITION BY tbl ORDER BY count(*) DESC) AS rn
          FROM flagged WHERE NOT resolved GROUP BY tbl, NULLIF(btrim(txt), '')
      ) x WHERE rn <= 5 GROUP BY tbl
  )
  SELECT a.tbl, a.scope, a.total, a.res, a.total - a.res,
         CASE WHEN a.total = 0 THEN 0 ELSE round(100.0 * a.res / a.total, 1) END,
         a.new_total, a.new_res,
         COALESCE(t.items, '[]'::jsonb)
    FROM agg a LEFT JOIN top_bad t ON t.tbl = a.tbl
   ORDER BY a.tbl;
END;
$$;

REVOKE ALL ON FUNCTION public.get_location_reconciliation_report(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_location_reconciliation_report(date) TO authenticated;