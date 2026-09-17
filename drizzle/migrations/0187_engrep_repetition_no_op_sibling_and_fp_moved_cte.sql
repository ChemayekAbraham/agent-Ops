-- ECHO: ENGREP-NOOP-SIBLING-20260918-S
-- 1. no_op gains a fourth condition: no OTHER object claimed by the same commits
--    may have changed = true in that window (a named-but-unaltered table is a
--    referenced object, not wasted work).
-- 2. The +/-3-day "fingerprint moved nearby" test is computed once as a CTE keyed
--    on object_base instead of a correlated subquery per unit. count(DISTINCT ..)
--    is not allowed as a window function, so the equivalent min<>max test is used,
--    and the day offset is an integer so RANGE works on a date column.
-- Same output columns and order. safe_to_zero still true only for no_op/duplicate.

CREATE OR REPLACE VIEW public.engrep_repetition AS
WITH fp_moved AS (
  SELECT s.object_base,
         s.captured_for,
         min(s.fingerprint) OVER (
           PARTITION BY s.object_base
           ORDER BY (s.captured_for - DATE '2000-01-01')
           RANGE BETWEEN 3 PRECEDING AND 3 FOLLOWING)
         <> max(s.fingerprint) OVER (
           PARTITION BY s.object_base
           ORDER BY (s.captured_for - DATE '2000-01-01')
           RANGE BETWEEN 3 PRECEDING AND 3 FOLLOWING) AS moved_nearby
    FROM engrep_catalog_snapshot s
), fp_changed AS (
  SELECT s.object_base,
         s.captured_for,
         s.fingerprint IS DISTINCT FROM lag(s.fingerprint) OVER (
           PARTITION BY s.object_key ORDER BY s.captured_for) AS changed_at
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
), unit_changed_map AS (
  SELECT w.id AS window_id,
         c.object_base,
         bool_or(COALESCE(c.changed_at, false)) AS changed
    FROM engrep_windows w
    JOIN fp_changed c ON c.captured_for = w.period_end
   GROUP BY w.id, c.object_base
), delta_map AS (
  SELECT w.id AS window_id,
         c.object_base,
         bool_or(COALESCE(c.changed_at, false)) AS in_delta
    FROM engrep_windows w
    JOIN fp_changed c ON c.captured_for <= w.period_end
   GROUP BY w.id, c.object_base
), moved_map AS (
  SELECT w.id AS window_id,
         f.object_base,
         bool_or(f.moved_nearby) AS moved_nearby
    FROM engrep_windows w
    JOIN fp_moved f ON f.captured_for = w.period_end
   GROUP BY w.id, f.object_base
), sibling AS (
  SELECT c_1.window_id,
         c_1.unit_kind,
         c_1.unit_key,
         bool_or(COALESCE(m.changed, false)) AS sibling_changed
    FROM commits c_1
    JOIN engrep_rows r ON r.window_id = c_1.window_id AND r.evidence_ref = c_1.evidence_ref
    CROSS JOIN LATERAL unnest(r.claimed_objects) so(object_name)
    LEFT JOIN unit_changed_map m
           ON m.window_id = c_1.window_id
          AND m.object_base = split_part(so.object_name, '('::text, 1)
   WHERE NOT c_1.bulk_claim
     AND r.claimed_objects IS NOT NULL
     AND so.object_name <> c_1.unit_key
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
         COALESCE(uc.changed, false) AS unit_changed,
         d.unit_key IS NOT NULL AS is_dupe,
         s.shas AS undo_sha_list,
         CASE
           WHEN a.unit_kind <> 'object'::text THEN false
           ELSE COALESCE(dm.in_delta, false)
         END AS in_catalog_delta,
         CASE
           WHEN a.unit_kind <> 'object'::text THEN true
           ELSE NOT COALESCE(mm.moved_nearby, false)
         END AS stable_around_window,
         COALESCE(sb.sibling_changed, false) AS sibling_changed
    FROM agg a
    LEFT JOIN unit_changed_map uc
           ON a.unit_kind = 'object'::text
          AND uc.window_id = a.window_id
          AND uc.object_base = split_part(a.unit_key, '('::text, 1)
    LEFT JOIN delta_map dm
           ON a.unit_kind = 'object'::text
          AND dm.window_id = a.window_id
          AND dm.object_base = split_part(a.unit_key, '('::text, 1)
    LEFT JOIN moved_map mm
           ON a.unit_kind = 'object'::text
          AND mm.window_id = a.window_id
          AND mm.object_base = split_part(a.unit_key, '('::text, 1)
    LEFT JOIN dupes d ON d.window_id = a.window_id AND d.unit_kind = a.unit_kind AND d.unit_key = a.unit_key
    LEFT JOIN undo_shas s ON s.window_id = a.window_id AND s.unit_kind = a.unit_kind AND s.unit_key = a.unit_key
    LEFT JOIN sibling sb ON sb.window_id = a.window_id AND sb.unit_kind = a.unit_kind AND sb.unit_key = a.unit_key
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
           WHEN k.unit_changed = false AND k.in_catalog_delta = false
                AND k.stable_around_window AND k.sibling_changed = false THEN 'no_op'::text
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

COMMENT ON COLUMN public.engrep_repetition.safe_to_zero IS
  'True only for repeat_kind no_op and duplicate. Nothing downstream may zero a row where safe_to_zero is false.';
