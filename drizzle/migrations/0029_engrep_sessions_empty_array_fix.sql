CREATE OR REPLACE VIEW public.engrep_sessions
WITH (security_invoker = true) AS
WITH cls AS (
  SELECT sr.window_id, sr.engineer_id, sr.session_seq,
         ARRAY_AGG(DISTINCT c ORDER BY c) AS change_classes
  FROM public.engrep_session_rows sr
  CROSS JOIN LATERAL unnest(COALESCE(sr.change_classes, ARRAY[]::text[])) AS t(c)
  GROUP BY sr.window_id, sr.engineer_id, sr.session_seq
),
pth AS (
  SELECT sr.window_id, sr.engineer_id, sr.session_seq,
         ARRAY_AGG(DISTINCT p ORDER BY p) AS paths,
         COUNT(DISTINCT p)::integer AS files_touched,
         bool_and(p LIKE '.lovable/%') AS plan_only
  FROM public.engrep_session_rows sr
  CROSS JOIN LATERAL unnest(COALESCE(sr.paths, ARRAY[]::text[])) AS t(p)
  GROUP BY sr.window_id, sr.engineer_id, sr.session_seq
)
SELECT sr.window_id,
       sr.engineer_id,
       sr.session_seq,
       MIN(sr.committed_at) AS started_at,
       MAX(sr.committed_at) AS ended_at,
       ROUND(EXTRACT(EPOCH FROM (MAX(sr.committed_at) - MIN(sr.committed_at))) / 60.0, 1) AS duration_minutes,
       COUNT(*)::integer AS item_count,
       COUNT(*) FILTER (WHERE sr.source = 'lovable_edit')::integer AS lovable_edits,
       COUNT(*) FILTER (WHERE sr.source <> 'lovable_edit')::integer AS external_commits,
       COALESCE(MAX(cls.change_classes), ARRAY[]::text[]) AS change_classes,
       COALESCE(MAX(pth.paths), ARRAY[]::text[]) AS paths,
       COALESCE(MAX(pth.files_touched), 0) AS files_touched,
       COUNT(*) FILTER (WHERE sr.claims_schema)::integer AS claims_count,
       COUNT(*) FILTER (WHERE sr.live_verified = 'yes')::integer AS live_yes,
       COUNT(*) FILTER (WHERE sr.live_verified = 'no')::integer AS live_no,
       COUNT(*) FILTER (WHERE sr.live_verified IS NULL OR sr.live_verified NOT IN ('yes','no'))::integer AS live_na,
       COUNT(*) FILTER (WHERE sr.zeroed)::integer AS zeroed_count,
       COUNT(*) FILTER (WHERE sr.untagged)::integer AS untagged_count,
       COUNT(*) FILTER (WHERE sr.migration_bearing)::integer AS migration_count,
       COALESCE(ARRAY_AGG(sr.evidence_ref) FILTER (WHERE sr.evidence_ref IS NOT NULL), ARRAY[]::text[]) AS evidence_refs,
       COALESCE(bool_and(pth.plan_only), false) AS plan_only,
       COALESCE(
         ARRAY_AGG(DISTINCT sr.commit_subject)
           FILTER (WHERE sr.commit_subject IS NOT NULL AND sr.commit_subject <> 'Changes'),
         ARRAY[]::text[]
       ) AS subjects
FROM public.engrep_session_rows sr
LEFT JOIN cls ON cls.window_id = sr.window_id AND cls.engineer_id = sr.engineer_id AND cls.session_seq = sr.session_seq
LEFT JOIN pth ON pth.window_id = sr.window_id AND pth.engineer_id = sr.engineer_id AND pth.session_seq = sr.session_seq
GROUP BY sr.window_id, sr.engineer_id, sr.session_seq;