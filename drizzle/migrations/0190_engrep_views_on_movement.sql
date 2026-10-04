-- ENGREP-VIEWS-ONMOVEMENT-20260918-U
-- Both views keep their exact current column lists and order.

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
     (EXISTS ( SELECT 1
          FROM engrep_catalog_movement m
            JOIN engrep_windows w ON w.id = oa.window_id
         WHERE m.object_base = split_part(oa.unit_key, '('::text, 1)
           AND m.captured_for = w.period_end
           AND m.moved_from_prev)) AS changed,
     (EXISTS ( SELECT 1
          FROM engrep_catalog_snapshot s2
            JOIN engrep_windows w2 ON w2.id = oa.window_id
         WHERE s2.object_base = split_part(oa.unit_key, '('::text, 1) AND s2.captured_for = w2.period_end)) AS verified_live,
     oa.sources,
     CASE
       WHEN (EXISTS ( SELECT 1 FROM engrep_catalog_snapshot s3
              JOIN engrep_windows w3 ON w3.id = oa.window_id
             WHERE s3.object_base = split_part(oa.unit_key, '('::text, 1) AND s3.captured_for = w3.period_end)) THEN 'live'::text
       WHEN (EXISTS ( SELECT 1 FROM engrep_catalog_snapshot s4
             WHERE s4.object_base = split_part(oa.unit_key, '('::text, 1))) THEN 'gone'::text
       ELSE 'never_landed'::text
     END AS unit_state
    FROM obj_agg oa
   WHERE NOT (oa.unit_key ~ '^[A-Z]'::text OR oa.unit_key ~ '^tmp_'::text OR (lower(oa.unit_key) = ANY (ARRAY['cannot'::text, 'finance'::text, 'engrep'::text, 'public'::text, 'select'::text, 'insert'::text, 'update'::text, 'delete'::text, 'all'::text, 'usage'::text, 'execute'::text, 'only'::text])))
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

CREATE OR REPLACE VIEW public.engrep_repetition AS
WITH fp_changed AS (
  SELECT s.object_base,
     s.captured_for,
     s.fingerprint IS DISTINCT FROM lag(s.fingerprint) OVER (PARTITION BY s.object_key ORDER BY s.captured_for) AS changed_at
    FROM engrep_catalog_snapshot s
), obj_facts AS (
  SELECT r.window_id,
     'object'::text AS unit_kind,
     co.object_name AS unit_key,
     r.evidence_ref,
     r.engineer_code,
     r.commit_subject,
     COALESCE(r.committed_at, r.harvested_at) AS touched_at,
     COALESCE(array_length(r.claimed_objects, 1), 0) > 25 AS bulk_claim
    FROM engrep_rows r
      CROSS JOIN LATERAL unnest(r.claimed_objects) co(object_name)
   WHERE r.claimed_objects IS NOT NULL AND array_length(r.claimed_objects, 1) > 0
), file_facts AS (
  SELECT t.window_id,
     'file'::text AS unit_kind,
     t.path AS unit_key,
     t.evidence_ref,
     e.code AS engineer_code,
     r.commit_subject,
     COALESCE(t.touched_at, r.committed_at, r.harvested_at) AS touched_at,
     COALESCE(array_length(r.claimed_objects, 1), 0) > 25 AS bulk_claim
    FROM engrep_file_touches t
      LEFT JOIN engrep_engineers e ON e.id = t.engineer_id
      LEFT JOIN engrep_rows r ON r.window_id = t.window_id AND r.evidence_ref = t.evidence_ref
), facts AS (
  SELECT obj_facts.window_id, obj_facts.unit_kind, obj_facts.unit_key, obj_facts.evidence_ref,
     obj_facts.engineer_code, obj_facts.commit_subject, obj_facts.touched_at, obj_facts.bulk_claim
    FROM obj_facts
  UNION ALL
  SELECT file_facts.window_id, file_facts.unit_kind, file_facts.unit_key, file_facts.evidence_ref,
     file_facts.engineer_code, file_facts.commit_subject, file_facts.touched_at, file_facts.bulk_claim
    FROM file_facts
), commits AS (
  SELECT facts.window_id, facts.unit_kind, facts.unit_key, facts.evidence_ref,
     min(facts.engineer_code) AS engineer_code,
     min(facts.commit_subject) AS commit_subject,
     min(facts.touched_at) AS touched_at,
     bool_or(facts.bulk_claim) AS bulk_claim
    FROM facts
   GROUP BY facts.window_id, facts.unit_kind, facts.unit_key, facts.evidence_ref
), agg AS (
  SELECT c_1.window_id, c_1.unit_kind, c_1.unit_key,
     count(*) FILTER (WHERE NOT c_1.bulk_claim)::integer AS commits,
     count(*) FILTER (WHERE c_1.bulk_claim)::integer AS bulk_commits,
     ARRAY( SELECT DISTINCT x.x
            FROM unnest(array_agg(c_1.engineer_code) FILTER (WHERE NOT c_1.bulk_claim)) x(x)
            WHERE x.x IS NOT NULL ORDER BY x.x) AS engineers,
     array_agg(c_1.evidence_ref ORDER BY c_1.touched_at, c_1.evidence_ref) AS repeat_refs,
     bool_or(NOT c_1.bulk_claim AND COALESCE(c_1.commit_subject, ''::text) ~* '^(revert|reverted to commit)'::text) AS has_undo
    FROM commits c_1
   GROUP BY c_1.window_id, c_1.unit_kind, c_1.unit_key
), dupes AS (
  SELECT DISTINCT a.window_id, a.unit_kind, a.unit_key
    FROM commits a
      JOIN commits b ON b.window_id = a.window_id AND b.unit_kind = a.unit_kind AND b.unit_key = a.unit_key AND b.evidence_ref <> a.evidence_ref
   WHERE NOT a.bulk_claim AND NOT b.bulk_claim AND a.engineer_code IS NOT NULL AND a.engineer_code = b.engineer_code
     AND COALESCE(a.commit_subject, ''::text) <> ''::text AND a.commit_subject = b.commit_subject
     AND a.touched_at IS NOT NULL AND b.touched_at IS NOT NULL AND a.touched_at < b.touched_at
     AND (b.touched_at - a.touched_at) <= '24:00:00'::interval
), undo_shas AS (
  SELECT c_1.window_id, c_1.unit_kind, c_1.unit_key,
     string_agg(DISTINCT "substring"(c_1.commit_subject, '[0-9a-f]{7,40}'::text), ', '::text) AS shas
    FROM commits c_1
   WHERE NOT c_1.bulk_claim AND COALESCE(c_1.commit_subject, ''::text) ~* '^(revert|reverted to commit)'::text
     AND "substring"(c_1.commit_subject, '[0-9a-f]{7,40}'::text) IS NOT NULL
   GROUP BY c_1.window_id, c_1.unit_kind, c_1.unit_key
), unit_changed_map AS (
  SELECT w.id AS window_id, c_1.object_base, bool_or(COALESCE(c_1.changed_at, false)) AS changed
    FROM engrep_windows w
      JOIN fp_changed c_1 ON c_1.captured_for = w.period_end
   GROUP BY w.id, c_1.object_base
), delta_map AS (
  SELECT w.id AS window_id, c_1.object_base, bool_or(COALESCE(c_1.changed_at, false)) AS in_delta
    FROM engrep_windows w
      JOIN fp_changed c_1 ON c_1.captured_for <= w.period_end
   GROUP BY w.id, c_1.object_base
), moved_map AS (
  SELECT w.id AS window_id, m.object_base, bool_or(COALESCE(m.moved_nearby, false)) AS moved_nearby
    FROM engrep_windows w
      JOIN engrep_catalog_movement m ON m.captured_for = w.period_end
   GROUP BY w.id, m.object_base
), sibling AS (
  SELECT c_1.window_id, c_1.unit_kind, c_1.unit_key,
     bool_or(COALESCE(m.changed, false)) AS sibling_changed
    FROM commits c_1
      JOIN engrep_rows r ON r.window_id = c_1.window_id AND r.evidence_ref = c_1.evidence_ref
      CROSS JOIN LATERAL unnest(r.claimed_objects) so(object_name)
      LEFT JOIN unit_changed_map m ON m.window_id = c_1.window_id AND m.object_base = split_part(so.object_name, '('::text, 1)
   WHERE NOT c_1.bulk_claim AND r.claimed_objects IS NOT NULL AND so.object_name <> c_1.unit_key
   GROUP BY c_1.window_id, c_1.unit_kind, c_1.unit_key
), kinds AS (
  SELECT a.window_id, a.unit_kind, a.unit_key, a.commits, a.bulk_commits, a.engineers, a.repeat_refs, a.has_undo,
     COALESCE(uc.changed, false) AS unit_changed,
     d.unit_key IS NOT NULL AS is_dupe,
     s.shas AS undo_sha_list,
     CASE WHEN a.unit_kind <> 'object'::text THEN false ELSE COALESCE(dm.in_delta, false) END AS in_catalog_delta,
     CASE WHEN a.unit_kind <> 'object'::text THEN true ELSE NOT COALESCE(mm.moved_nearby, false) END AS stable_around_window,
     COALESCE(sb.sibling_changed, false) AS sibling_changed
    FROM agg a
      LEFT JOIN unit_changed_map uc ON a.unit_kind = 'object'::text AND uc.window_id = a.window_id AND uc.object_base = split_part(a.unit_key, '('::text, 1)
      LEFT JOIN delta_map dm ON a.unit_kind = 'object'::text AND dm.window_id = a.window_id AND dm.object_base = split_part(a.unit_key, '('::text, 1)
      LEFT JOIN moved_map mm ON a.unit_kind = 'object'::text AND mm.window_id = a.window_id AND mm.object_base = split_part(a.unit_key, '('::text, 1)
      LEFT JOIN dupes d ON d.window_id = a.window_id AND d.unit_kind = a.unit_kind AND d.unit_key = a.unit_key
      LEFT JOIN undo_shas s ON s.window_id = a.window_id AND s.unit_kind = a.unit_kind AND s.unit_key = a.unit_key
      LEFT JOIN sibling sb ON sb.window_id = a.window_id AND sb.unit_kind = a.unit_kind AND sb.unit_key = a.unit_key
   WHERE a.commits > 1
), classified AS (
  SELECT k.window_id, k.unit_kind, k.unit_key, k.commits, k.bulk_commits, k.engineers, k.repeat_refs, k.has_undo,
     k.unit_changed, k.is_dupe, k.undo_sha_list, k.in_catalog_delta,
     CASE
       WHEN k.has_undo THEN 'undo'::text
       WHEN k.is_dupe THEN 'duplicate'::text
       WHEN k.unit_changed = false AND k.in_catalog_delta = false AND k.stable_around_window AND k.sibling_changed = false THEN 'no_op'::text
       WHEN COALESCE(array_length(k.engineers, 1), 0) > 1 THEN 're_entry_shared'::text
       ELSE 're_entry_solo'::text
     END AS repeat_kind
    FROM kinds k
)
SELECT window_id,
   unit_kind,
   unit_key,
   commits,
   engineers,
   repeat_kind,
   CASE
     WHEN repeat_kind = 'undo'::text AND undo_sha_list IS NOT NULL THEN ARRAY[undo_sha_list] || repeat_refs
     ELSE repeat_refs
   END AS repeat_refs,
   ((((((unit_kind || ' '::text) || unit_key) || ': '::text) || commits::text) || ' commits'::text) ||
     CASE WHEN COALESCE(array_length(engineers, 1), 0) > 0 THEN ' by '::text || array_to_string(engineers, '/'::text) ELSE ''::text END) ||
     CASE WHEN bulk_commits > 0 THEN (' (+'::text || bulk_commits::text) || ' bulk-claim commit(s) with >25 claimed objects excluded from repeat counting)'::text ELSE ''::text END AS repeat_evidence,
   repeat_kind = ANY (ARRAY['no_op'::text, 'duplicate'::text]) AS safe_to_zero
  FROM classified c;

COMMENT ON VIEW public.engrep_repetition IS 'Evidence-only repetition view. safe_to_zero is true only for no_op and duplicate. Movement signals read from engrep_catalog_movement.';
