-- Read-only session views over engrep_rows. No table, no row, no schedule, and
-- no adjudication function is touched. The 45-minute session gap is a literal.

CREATE OR REPLACE VIEW public.engrep_session_rows
WITH (security_invoker = on) AS
WITH flagged AS (
  SELECT r.id,
         r.window_id,
         r.engineer_id,
         r.committed_at,
         r.harvested_at,
         r.source,
         r.evidence_ref,
         r.change_classes,
         r.paths,
         r.live_verified,
         r.claims_schema,
         r.migration_bearing,
         r.zeroed,
         r.untagged,
         r.commit_subject,
         r.lovable_edit_id,
         r.edit_title,
         CASE
           WHEN LAG(r.committed_at) OVER w IS NULL THEN 1
           WHEN r.committed_at IS NULL THEN 1
           WHEN r.committed_at - LAG(r.committed_at) OVER w > INTERVAL '45 minutes' THEN 1
           ELSE 0
         END AS is_new_session
  FROM public.engrep_rows r
  WHERE r.engineer_id IS NOT NULL
  WINDOW w AS (
    PARTITION BY r.window_id, r.engineer_id
    ORDER BY r.committed_at NULLS LAST, r.harvested_at
  )
)
SELECT f.id,
       f.window_id,
       f.engineer_id,
       SUM(f.is_new_session) OVER (
         PARTITION BY f.window_id, f.engineer_id
         ORDER BY f.committed_at NULLS LAST, f.harvested_at
         ROWS UNBOUNDED PRECEDING
       )::integer AS session_seq,
       f.committed_at,
       f.source,
       f.evidence_ref,
       f.change_classes,
       f.paths,
       f.live_verified,
       f.claims_schema,
       f.migration_bearing,
       f.zeroed,
       f.untagged,
       f.commit_subject,
       f.lovable_edit_id,
       f.edit_title
FROM flagged f;

CREATE OR REPLACE VIEW public.engrep_sessions
WITH (security_invoker = on) AS
SELECT sr.window_id,
       sr.engineer_id,
       sr.session_seq,
       MIN(sr.committed_at) AS started_at,
       MAX(sr.committed_at) AS ended_at,
       ROUND(EXTRACT(EPOCH FROM (MAX(sr.committed_at) - MIN(sr.committed_at))) / 60.0, 1) AS duration_minutes,
       COUNT(*)::integer AS item_count,
       COUNT(*) FILTER (WHERE sr.source = 'lovable_edit')::integer AS lovable_edits,
       COUNT(*) FILTER (WHERE sr.source <> 'lovable_edit')::integer AS external_commits,
       COALESCE((
         SELECT ARRAY_AGG(DISTINCT c ORDER BY c)
         FROM unnest(COALESCE(ARRAY_AGG(sr.change_classes) FILTER (WHERE sr.change_classes IS NOT NULL), ARRAY[]::text[][])) AS t(c)
       ), ARRAY[]::text[]) AS change_classes,
       COALESCE((
         SELECT ARRAY_AGG(DISTINCT p ORDER BY p)
         FROM unnest(COALESCE(ARRAY_AGG(sr.paths) FILTER (WHERE sr.paths IS NOT NULL), ARRAY[]::text[][])) AS t(p)
       ), ARRAY[]::text[]) AS paths,
       COALESCE((
         SELECT COUNT(DISTINCT p)
         FROM unnest(COALESCE(ARRAY_AGG(sr.paths) FILTER (WHERE sr.paths IS NOT NULL), ARRAY[]::text[][])) AS t(p)
       ), 0)::integer AS files_touched,
       COUNT(*) FILTER (WHERE sr.claims_schema)::integer AS claims_count,
       COUNT(*) FILTER (WHERE sr.live_verified = 'yes')::integer AS live_yes,
       COUNT(*) FILTER (WHERE sr.live_verified = 'no')::integer AS live_no,
       COUNT(*) FILTER (WHERE sr.live_verified IS NULL OR sr.live_verified NOT IN ('yes','no'))::integer AS live_na,
       COUNT(*) FILTER (WHERE sr.zeroed)::integer AS zeroed_count,
       COUNT(*) FILTER (WHERE sr.untagged)::integer AS untagged_count,
       COUNT(*) FILTER (WHERE sr.migration_bearing)::integer AS migration_count,
       COALESCE(ARRAY_AGG(sr.evidence_ref) FILTER (WHERE sr.evidence_ref IS NOT NULL), ARRAY[]::text[]) AS evidence_refs,
       COALESCE((
         SELECT bool_and(p LIKE '.lovable/%') AND COUNT(*) > 0
         FROM unnest(COALESCE(ARRAY_AGG(sr.paths) FILTER (WHERE sr.paths IS NOT NULL), ARRAY[]::text[][])) AS t(p)
       ), false) AS plan_only,
       COALESCE(
         ARRAY_AGG(DISTINCT sr.commit_subject)
           FILTER (WHERE sr.commit_subject IS NOT NULL AND sr.commit_subject <> 'Changes'),
         ARRAY[]::text[]
       ) AS subjects
FROM public.engrep_session_rows sr
GROUP BY sr.window_id, sr.engineer_id, sr.session_seq;

REVOKE ALL ON public.engrep_session_rows FROM PUBLIC;
REVOKE ALL ON public.engrep_session_rows FROM anon;
REVOKE ALL ON public.engrep_sessions FROM PUBLIC;
REVOKE ALL ON public.engrep_sessions FROM anon;
GRANT SELECT ON public.engrep_session_rows TO authenticated;
GRANT SELECT ON public.engrep_session_rows TO service_role;
GRANT SELECT ON public.engrep_sessions TO authenticated;
GRANT SELECT ON public.engrep_sessions TO service_role;