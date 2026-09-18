-- ENGREP-REPETITION-FIX-20260917-G
-- Evidence-only reference view. No band, no score, no points, no payout.
-- Priority reordered so 'no_op' is tested LAST; 'no_op' narrowed; safe_to_zero added.
-- NOTE: public.engrep_catalog_delta does not exist in this database. The
-- "appears in no catalog delta" condition is derived from
-- public.engrep_catalog_snapshot: a unit is "in a delta" when its fingerprint
-- differs between any two consecutive snapshots at or before the window close.

CREATE OR REPLACE VIEW public.engrep_repetition AS
WITH obj_facts AS (
  SELECT
    r.window_id,
    'object'::text AS unit_kind,
    co.object_name AS unit_key,
    r.evidence_ref,
    r.engineer_code,
    r.commit_subject,
    COALESCE(r.committed_at, r.harvested_at) AS touched_at,
    COALESCE(array_length(r.claimed_objects, 1), 0) > 25 AS bulk_claim
  FROM public.engrep_rows r
  CROSS JOIN LATERAL unnest(r.claimed_objects) AS co(object_name)
  WHERE r.claimed_objects IS NOT NULL
    AND array_length(r.claimed_objects, 1) > 0
),
file_facts AS (
  SELECT
    t.window_id,
    'file'::text AS unit_kind,
    t.path AS unit_key,
    t.evidence_ref,
    e.code AS engineer_code,
    r.commit_subject,
    COALESCE(t.touched_at, r.committed_at, r.harvested_at) AS touched_at,
    COALESCE(array_length(r.claimed_objects, 1), 0) > 25 AS bulk_claim
  FROM public.engrep_file_touches t
  LEFT JOIN public.engrep_engineers e ON e.id = t.engineer_id
  LEFT JOIN public.engrep_rows r
    ON r.window_id = t.window_id AND r.evidence_ref = t.evidence_ref
),
facts AS (
  SELECT * FROM obj_facts
  UNION ALL
  SELECT * FROM file_facts
),
commits AS (
  SELECT
    window_id, unit_kind, unit_key, evidence_ref,
    min(engineer_code)  AS engineer_code,
    min(commit_subject) AS commit_subject,
    min(touched_at)     AS touched_at,
    bool_or(bulk_claim) AS bulk_claim
  FROM facts
  GROUP BY window_id, unit_kind, unit_key, evidence_ref
),
agg AS (
  SELECT
    c.window_id,
    c.unit_kind,
    c.unit_key,
    count(*) FILTER (WHERE NOT c.bulk_claim)::int AS commits,
    count(*) FILTER (WHERE c.bulk_claim)::int     AS bulk_commits,
    ARRAY(
      SELECT DISTINCT x
      FROM unnest(array_agg(c.engineer_code) FILTER (WHERE NOT c.bulk_claim)) x
      WHERE x IS NOT NULL
      ORDER BY x
    ) AS engineers,
    array_agg(c.evidence_ref ORDER BY c.touched_at NULLS LAST, c.evidence_ref) AS repeat_refs,
    bool_or(
      NOT c.bulk_claim
      AND COALESCE(c.commit_subject, '') ~* '^(revert|reverted to commit)'
    ) AS has_undo
  FROM commits c
  GROUP BY c.window_id, c.unit_kind, c.unit_key
),
dupes AS (
  SELECT DISTINCT a.window_id, a.unit_kind, a.unit_key
  FROM commits a
  JOIN commits b
    ON b.window_id = a.window_id
   AND b.unit_kind = a.unit_kind
   AND b.unit_key  = a.unit_key
   AND b.evidence_ref <> a.evidence_ref
  WHERE NOT a.bulk_claim
    AND NOT b.bulk_claim
    AND a.engineer_code IS NOT NULL
    AND a.engineer_code = b.engineer_code
    AND COALESCE(a.commit_subject, '') <> ''
    AND a.commit_subject = b.commit_subject
    AND a.touched_at IS NOT NULL
    AND b.touched_at IS NOT NULL
    AND a.touched_at < b.touched_at
    AND b.touched_at - a.touched_at <= interval '24 hours'
),
undo_shas AS (
  SELECT
    c.window_id, c.unit_kind, c.unit_key,
    string_agg(DISTINCT substring(c.commit_subject FROM '[0-9a-f]{7,40}'), ', ') AS shas
  FROM commits c
  WHERE NOT c.bulk_claim
    AND COALESCE(c.commit_subject, '') ~* '^(revert|reverted to commit)'
    AND substring(c.commit_subject FROM '[0-9a-f]{7,40}') IS NOT NULL
  GROUP BY c.window_id, c.unit_kind, c.unit_key
),
kinds AS (
  SELECT
    a.*,
    COALESCE(u.changed, false) AS unit_changed,
    d.unit_key IS NOT NULL     AS is_dupe,
    s.shas                     AS undo_sha_list,
    CASE
      WHEN a.unit_kind <> 'object' THEN false
      ELSE EXISTS (
        SELECT 1
        FROM public.engrep_windows w
        JOIN public.engrep_catalog_snapshot sn
          ON sn.captured_for <= w.period_end
         AND (
              sn.object_key = a.unit_key
           OR sn.object_key LIKE a.unit_key || '(%'
           OR sn.object_key LIKE '%.' || a.unit_key
           OR sn.object_key LIKE a.unit_key || '.%'
         )
        JOIN LATERAL (
          SELECT sp.fingerprint
          FROM public.engrep_catalog_snapshot sp
          WHERE sp.object_key = sn.object_key
            AND sp.captured_for < sn.captured_for
          ORDER BY sp.captured_for DESC
          LIMIT 1
        ) prev ON true
        WHERE w.id = a.window_id
          AND prev.fingerprint IS DISTINCT FROM sn.fingerprint
      )
    END AS in_catalog_delta
  FROM agg a
  LEFT JOIN public.engrep_work_units u
    ON u.window_id = a.window_id
   AND u.unit_kind = a.unit_kind
   AND u.unit_key  = a.unit_key
  LEFT JOIN dupes d
    ON d.window_id = a.window_id
   AND d.unit_kind = a.unit_kind
   AND d.unit_key  = a.unit_key
  LEFT JOIN undo_shas s
    ON s.window_id = a.window_id
   AND s.unit_kind = a.unit_kind
   AND s.unit_key  = a.unit_key
  WHERE a.commits > 1
),
classified AS (
  SELECT
    k.*,
    CASE
      WHEN k.has_undo THEN 'undo'
      WHEN k.is_dupe  THEN 'duplicate'
      WHEN k.unit_changed = false AND k.in_catalog_delta = false THEN 'no_op'
      WHEN COALESCE(array_length(k.engineers, 1), 0) > 1 THEN 're_entry_shared'
      ELSE 're_entry_solo'
    END AS repeat_kind
  FROM kinds k
)
SELECT
  c.window_id,
  c.unit_kind,
  c.unit_key,
  c.commits,
  c.engineers,
  c.repeat_kind,
  CASE
    WHEN c.repeat_kind = 'undo' AND c.undo_sha_list IS NOT NULL
      THEN ARRAY[c.undo_sha_list]::text[] || c.repeat_refs
    ELSE c.repeat_refs
  END AS repeat_refs,
  c.unit_kind || ' ' || c.unit_key || ': ' || c.commits::text || ' commits'
    || CASE WHEN COALESCE(array_length(c.engineers, 1), 0) > 0
            THEN ' by ' || array_to_string(c.engineers, '/')
            ELSE '' END
    || CASE WHEN c.bulk_commits > 0
            THEN ' (+' || c.bulk_commits::text
                 || ' bulk-claim commit(s) with >25 claimed objects excluded from repeat counting)'
            ELSE '' END
    AS repeat_evidence,
  (c.repeat_kind IN ('no_op', 'duplicate')) AS safe_to_zero
FROM classified c;

COMMENT ON VIEW public.engrep_repetition IS
  'Repetition reference for units touched by more than one commit in a window. Evidence only: no band, no score, no points, no payout, and it zeroes nothing. Kind precedence is undo -> duplicate -> no_op -> re_entry_shared -> re_entry_solo, with no_op tested only after undo and duplicate and requiring multi-commit, changed = false, and absence from any catalog delta up to window close. Commits claiming more than 25 objects (e.g. Lovable "Reverted to commit <sha>" re-claims) are excluded from repeat counting and noted in repeat_evidence.';

COMMENT ON COLUMN public.engrep_repetition.safe_to_zero IS
  'True only for repeat_kind in (no_op, duplicate). Every other kind is false. Nothing downstream may zero a row where safe_to_zero is false.';

GRANT SELECT ON public.engrep_repetition TO authenticated;
GRANT SELECT ON public.engrep_repetition TO service_role;