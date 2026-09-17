-- ECHO: ENGREP-UNITSTATE-20260918-R
-- Undoes the ENGREP-UNITNOISE-20260918-N catalogue-presence filter, which hid
-- claimed-but-never-built money-path objects. Noise is now a SHAPE test only.
-- Adds unit_state (live | gone | never_landed) as the LAST column.
-- No band, no score, no points, no payout.

DROP VIEW IF EXISTS public.engrep_repetition;

CREATE OR REPLACE VIEW public.engrep_work_units AS
WITH obj AS (
  SELECT r.window_id,
         co.object_name AS unit_key,
         r.evidence_ref,
         r.engineer_code,
         r.source,
         COALESCE(r.committed_at, r.harvested_at) AS touched_at
    FROM engrep_rows r
    CROSS JOIN LATERAL unnest(r.claimed_objects) co(object_name)
   WHERE r.claimed_objects IS NOT NULL AND array_length(r.claimed_objects, 1) > 0
), obj_agg AS (
  SELECT obj.window_id,
         obj.unit_key,
         count(DISTINCT obj.evidence_ref)::integer AS commits,
         ARRAY( SELECT DISTINCT x.x FROM unnest(array_agg(obj.engineer_code)) x(x)
                 WHERE x.x IS NOT NULL ORDER BY x.x) AS engineers,
         min(obj.touched_at) AS first_touch,
         max(obj.touched_at) AS last_touch,
         ARRAY( SELECT DISTINCT x.x FROM unnest(array_agg(obj.source)) x(x)
                 WHERE x.x IS NOT NULL ORDER BY x.x) AS sources
    FROM obj
   GROUP BY obj.window_id, obj.unit_key
), obj_final AS (
  SELECT oa.window_id,
         'object'::text AS unit_kind,
         oa.unit_key,
         oa.commits,
         oa.engineers,
         CASE
           WHEN oa.engineers = '{}'::text[] THEN ARRAY['none'::text]
           WHEN array_length(oa.engineers, 1) > 1 THEN ARRAY['shared'::text]
           ELSE ARRAY['named'::text]
         END AS owner_classes,
         oa.first_touch,
         oa.last_touch,
         COALESCE(( SELECT s_now.fingerprint IS DISTINCT FROM s_prev.fingerprint
                      FROM engrep_windows w
                      JOIN engrep_catalog_snapshot s_now
                        ON s_now.captured_for = w.period_end
                       AND s_now.object_base = split_part(oa.unit_key, '('::text, 1)
                      LEFT JOIN LATERAL ( SELECT sp.fingerprint
                                            FROM engrep_catalog_snapshot sp
                                           WHERE sp.object_key = s_now.object_key
                                             AND sp.captured_for < w.period_end
                                           ORDER BY sp.captured_for DESC
                                           LIMIT 1) s_prev ON true
                     WHERE w.id = oa.window_id
                     LIMIT 1), false) AS changed,
         (EXISTS ( SELECT 1
                     FROM engrep_catalog_snapshot s2
                     JOIN engrep_windows w2 ON w2.id = oa.window_id
                    WHERE s2.object_base = split_part(oa.unit_key, '('::text, 1)
                      AND s2.captured_for = w2.period_end)) AS verified_live,
         oa.sources,
         CASE
           WHEN EXISTS ( SELECT 1
                           FROM engrep_catalog_snapshot s3
                           JOIN engrep_windows w3 ON w3.id = oa.window_id
                          WHERE s3.object_base = split_part(oa.unit_key, '('::text, 1)
                            AND s3.captured_for = w3.period_end) THEN 'live'
           WHEN EXISTS ( SELECT 1
                           FROM engrep_catalog_snapshot s4
                          WHERE s4.object_base = split_part(oa.unit_key, '('::text, 1)) THEN 'gone'
           ELSE 'never_landed'
         END AS unit_state
    FROM obj_agg oa
   WHERE NOT (
           oa.unit_key ~ '^[A-Z]'
           OR oa.unit_key ~ '^tmp_'
           OR lower(oa.unit_key) = ANY (ARRAY['cannot','finance','engrep','public',
                'select','insert','update','delete','all','usage','execute','only'])
         )
), fil_agg AS (
  SELECT t.window_id,
         'file'::text AS unit_kind,
         t.path AS unit_key,
         count(DISTINCT t.evidence_ref)::integer AS commits,
         ARRAY( SELECT DISTINCT x.x FROM unnest(array_agg(e.code)) x(x)
                 WHERE x.x IS NOT NULL ORDER BY x.x) AS engineers,
         min(t.touched_at) AS first_touch,
         max(t.touched_at) AS last_touch,
         count(DISTINCT t.blob_sha) > 1 AS changed,
         ARRAY( SELECT DISTINCT x.x FROM unnest(array_agg(t.source)) x(x)
                 WHERE x.x IS NOT NULL ORDER BY x.x) AS sources
    FROM engrep_file_touches t
    LEFT JOIN engrep_engineers e ON e.id = t.engineer_id
   GROUP BY t.window_id, t.path
)
SELECT obj_final.window_id,
       obj_final.unit_kind,
       obj_final.unit_key,
       obj_final.commits,
       obj_final.engineers,
       obj_final.owner_classes,
       obj_final.first_touch,
       obj_final.last_touch,
       obj_final.changed,
       obj_final.verified_live,
       obj_final.sources,
       obj_final.unit_state
  FROM obj_final
UNION ALL
SELECT fil_agg.window_id,
       fil_agg.unit_kind,
       fil_agg.unit_key,
       fil_agg.commits,
       fil_agg.engineers,
       CASE
         WHEN fil_agg.engineers = '{}'::text[] THEN ARRAY['none'::text]
         WHEN array_length(fil_agg.engineers, 1) > 1 THEN ARRAY['shared'::text]
         ELSE ARRAY['named'::text]
       END AS owner_classes,
       fil_agg.first_touch,
       fil_agg.last_touch,
       fil_agg.changed,
       NULL::boolean AS verified_live,
       fil_agg.sources,
       NULL::text AS unit_state
  FROM fil_agg;

COMMENT ON COLUMN public.engrep_work_units.unit_state IS
  'live = object_base present in the period_end snapshot; gone = present in an earlier snapshot but absent at period_end; never_landed = present in no snapshot ever (claimed but never built). NULL for file units. Carries no band, score or points.';

CREATE OR REPLACE VIEW public.engrep_claim_noise AS
WITH obj AS (
  SELECT r.window_id,
         co.object_name AS unit_key,
         r.evidence_ref,
         r.engineer_code,
         COALESCE(r.committed_at, r.harvested_at) AS touched_at
    FROM engrep_rows r
    CROSS JOIN LATERAL unnest(r.claimed_objects) co(object_name)
   WHERE r.claimed_objects IS NOT NULL AND array_length(r.claimed_objects, 1) > 0
), obj_agg AS (
  SELECT obj.window_id,
         obj.unit_key,
         count(DISTINCT obj.evidence_ref)::integer AS commits,
         ARRAY( SELECT DISTINCT x.x FROM unnest(array_agg(obj.engineer_code)) x(x)
                 WHERE x.x IS NOT NULL ORDER BY x.x) AS engineers,
         min(obj.touched_at) AS first_touch,
         max(obj.touched_at) AS last_touch
    FROM obj
   GROUP BY obj.window_id, obj.unit_key
)
SELECT oa.window_id,
       oa.unit_key,
       oa.commits,
       oa.engineers,
       oa.first_touch,
       oa.last_touch
  FROM obj_agg oa
 WHERE oa.unit_key ~ '^[A-Z]'
    OR oa.unit_key ~ '^tmp_'
    OR lower(oa.unit_key) = ANY (ARRAY['cannot','finance','engrep','public',
         'select','insert','update','delete','all','usage','execute','only']);

COMMENT ON VIEW public.engrep_claim_noise IS
  'Claimed strings rejected on SHAPE alone (capitalised prose from GRANT lines, tmp_* scratch names, SQL stopwords), so they are excluded from engrep_work_units. Absence from the catalogue is no longer noise: those units appear with unit_state = never_landed. Carries no band, score or points.';
