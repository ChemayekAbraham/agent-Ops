CREATE OR REPLACE VIEW public.engrep_work_units AS
WITH obj AS (
  SELECT
    r.window_id,
    co.object_name AS unit_key,
    r.evidence_ref,
    r.engineer_code,
    r.source,
    COALESCE(r.committed_at, r.harvested_at) AS touched_at
  FROM public.engrep_rows r
  CROSS JOIN LATERAL unnest(r.claimed_objects) AS co(object_name)
  WHERE r.claimed_objects IS NOT NULL AND array_length(r.claimed_objects, 1) > 0
),
obj_agg AS (
  SELECT
    window_id,
    unit_key,
    count(DISTINCT evidence_ref)::int AS commits,
    ARRAY(SELECT DISTINCT x FROM unnest(array_agg(engineer_code)) x WHERE x IS NOT NULL ORDER BY x) AS engineers,
    min(touched_at) AS first_touch,
    max(touched_at) AS last_touch,
    ARRAY(SELECT DISTINCT x FROM unnest(array_agg(source)) x WHERE x IS NOT NULL ORDER BY x) AS sources
  FROM obj
  GROUP BY window_id, unit_key
),
obj_final AS (
  SELECT
    oa.window_id,
    'object'::text AS unit_kind,
    oa.unit_key,
    oa.commits,
    oa.engineers,
    CASE
      WHEN oa.engineers = '{}' THEN ARRAY['none']::text[]
      WHEN array_length(oa.engineers, 1) > 1 THEN ARRAY['shared']::text[]
      ELSE ARRAY['named']::text[]
    END AS owner_classes,
    oa.first_touch,
    oa.last_touch,
    COALESCE((
      SELECT count(DISTINCT s.fingerprint) > 1
      FROM public.engrep_catalog_snapshot s
      JOIN public.engrep_windows w ON w.id = oa.window_id
      WHERE s.object_key = oa.unit_key
        AND s.captured_for >= w.period_start
        AND s.captured_for <= w.period_end
    ), false) AS changed,
    EXISTS (
      SELECT 1
      FROM public.engrep_catalog_snapshot s2
      JOIN public.engrep_windows w2 ON w2.id = oa.window_id
      WHERE s2.object_key = oa.unit_key
        AND s2.captured_for = w2.period_end
    ) AS verified_live,
    oa.sources
  FROM obj_agg oa
),
fil_agg AS (
  SELECT
    t.window_id,
    'file'::text AS unit_kind,
    t.path AS unit_key,
    count(DISTINCT t.evidence_ref)::int AS commits,
    ARRAY(SELECT DISTINCT x FROM unnest(array_agg(e.code)) x WHERE x IS NOT NULL ORDER BY x) AS engineers,
    min(t.touched_at) AS first_touch,
    max(t.touched_at) AS last_touch,
    count(DISTINCT t.blob_sha) > 1 AS changed,
    ARRAY(SELECT DISTINCT x FROM unnest(array_agg(t.source)) x WHERE x IS NOT NULL ORDER BY x) AS sources
  FROM public.engrep_file_touches t
  LEFT JOIN public.engrep_engineers e ON e.id = t.engineer_id
  GROUP BY t.window_id, t.path
)
SELECT
  window_id, unit_kind, unit_key, commits, engineers, owner_classes,
  first_touch, last_touch, changed, verified_live, sources
FROM obj_final
UNION ALL
SELECT
  window_id, unit_kind, unit_key, commits, engineers,
  CASE
    WHEN engineers = '{}' THEN ARRAY['none']::text[]
    WHEN array_length(engineers, 1) > 1 THEN ARRAY['shared']::text[]
    ELSE ARRAY['named']::text[]
  END AS owner_classes,
  first_touch, last_touch, changed, NULL::boolean AS verified_live, sources
FROM fil_agg;

GRANT SELECT ON public.engrep_work_units TO authenticated;
GRANT SELECT ON public.engrep_work_units TO service_role;