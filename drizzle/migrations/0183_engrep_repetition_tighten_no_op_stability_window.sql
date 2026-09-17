-- ECHO: ENGREP-NOOP-TIGHTEN-20260918-P
-- no_op now additionally requires the object's fingerprint to be identical in every
-- catalogue snapshot from period_end - 3 days through period_end + 3 days, so that
-- commit-time vs apply-time lag and "named but not altered" tables fall through to
-- re_entry_*. safe_to_zero unchanged. Same output columns and order.

CREATE OR REPLACE VIEW public.engrep_repetition AS
WITH obj_facts AS (
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
  SELECT window_id, unit_kind, unit_key, evidence_ref, engineer_code, commit_subject, touched_at, bulk_claim FROM obj_facts
  UNION ALL
  SELECT window_id, unit_kind, unit_key, evidence_ref, engineer_code, commit_subject, touched_at, bulk_claim FROM file_facts
), commits AS (
  SELECT facts.window_id,
         facts.unit_kind,
         facts.unit_key,
         facts.evidence_ref,
         min(facts.engineer_code) AS engineer_code,
         min(facts.commit_subject) AS commit_subject,
         min(facts.touched_at) AS touched_at,
         bool_or(facts.bulk_claim) AS bulk_claim
    FROM facts
   GROUP BY facts.window_id, facts.unit_kind, facts.unit_key, facts.evidence_ref
), agg AS (
  SELECT c_1.window_id,
         c_1.unit_kind,
         c_1.unit_key,
         count(*) FILTER (WHERE NOT c_1.bulk_claim)::integer AS commits,
         count(*) FILTER (WHERE c_1.bulk_claim)::integer AS bulk_commits,
         ARRAY( SELECT DISTINCT x.x
                  FROM unnest(array_agg(c_1.engineer_code) FILTER (WHERE NOT c_1.bulk_claim)) x(x)
                 WHERE x.x IS NOT NULL
                 ORDER BY x.x) AS engineers,
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
), kinds AS (
  SELECT a.window_id,
         a.unit_kind,
         a.unit_key,
         a.commits,
         a.bulk_commits,
         a.engineers,
         a.repeat_refs,
         a.has_undo,
         COALESCE(u.changed, false) AS unit_changed,
         d.unit_key IS NOT NULL AS is_dupe,
         s.shas AS undo_sha_list,
         CASE
           WHEN a.unit_kind <> 'object'::text THEN false
           ELSE (EXISTS ( SELECT 1
                            FROM engrep_windows w
                            JOIN engrep_catalog_snapshot sn
                              ON sn.captured_for <= w.period_end
                             AND (sn.object_key = a.unit_key
                                  OR sn.object_key ~~ (a.unit_key || '(%'::text)
                                  OR sn.object_key ~~ ('%.'::text || a.unit_key)
                                  OR sn.object_key ~~ (a.unit_key || '.%'::text))
                            JOIN LATERAL ( SELECT sp.fingerprint
                                             FROM engrep_catalog_snapshot sp
                                            WHERE sp.object_key = sn.object_key AND sp.captured_for < sn.captured_for
                                            ORDER BY sp.captured_for DESC
                                            LIMIT 1) prev ON true
                           WHERE w.id = a.window_id AND prev.fingerprint IS DISTINCT FROM sn.fingerprint))
         END AS in_catalog_delta,
         CASE
           WHEN a.unit_kind <> 'object'::text THEN true
           ELSE NOT (EXISTS ( SELECT 1
                                FROM engrep_windows w
                                JOIN engrep_catalog_snapshot sn
                                  ON sn.captured_for >= (w.period_end - 3)
                                 AND sn.captured_for <= (w.period_end + 3)
                                 AND (sn.object_base = split_part(a.unit_key, '('::text, 1)
                                      OR sn.object_key = a.unit_key
                                      OR sn.object_key ~~ (a.unit_key || '(%'::text)
                                      OR sn.object_key ~~ ('%.'::text || a.unit_key)
                                      OR sn.object_key ~~ (a.unit_key || '.%'::text))
                               WHERE w.id = a.window_id
                               GROUP BY sn.object_key
                              HAVING count(DISTINCT sn.fingerprint) > 1))
         END AS stable_around_window
    FROM agg a
    LEFT JOIN engrep_work_units u ON u.window_id = a.window_id AND u.unit_kind = a.unit_kind AND u.unit_key = a.unit_key
    LEFT JOIN dupes d ON d.window_id = a.window_id AND d.unit_kind = a.unit_kind AND d.unit_key = a.unit_key
    LEFT JOIN undo_shas s ON s.window_id = a.window_id AND s.unit_kind = a.unit_kind AND s.unit_key = a.unit_key
   WHERE a.commits > 1
), classified AS (
  SELECT k.window_id,
         k.unit_kind,
         k.unit_key,
         k.commits,
         k.bulk_commits,
         k.engineers,
         k.repeat_refs,
         k.has_undo,
         k.unit_changed,
         k.is_dupe,
         k.undo_sha_list,
         k.in_catalog_delta,
         CASE
           WHEN k.has_undo THEN 'undo'::text
           WHEN k.is_dupe THEN 'duplicate'::text
           WHEN k.unit_changed = false AND k.in_catalog_delta = false AND k.stable_around_window THEN 'no_op'::text
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
         CASE
           WHEN COALESCE(array_length(engineers, 1), 0) > 0 THEN ' by '::text || array_to_string(engineers, '/'::text)
           ELSE ''::text
         END) ||
         CASE
           WHEN bulk_commits > 0 THEN (' (+'::text || bulk_commits::text) || ' bulk-claim commit(s) with >25 claimed objects excluded from repeat counting)'::text
           ELSE ''::text
         END AS repeat_evidence,
       repeat_kind = ANY (ARRAY['no_op'::text, 'duplicate'::text]) AS safe_to_zero
  FROM classified c;
