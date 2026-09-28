CREATE INDEX IF NOT EXISTS engrep_file_touches_path_touched_idx
  ON public.engrep_file_touches (path, touched_at);

CREATE VIEW public.engrep_file_survival WITH (security_invoker = on) AS
WITH b AS (
  SELECT t.window_id, t.evidence_ref, t.path, t.engineer_id, t.touched_at, t.created_at, t.blob_sha,
         lag(t.blob_sha) OVER w AS prev_blob,
         row_number() OVER w AS seq
    FROM public.engrep_file_touches t
   WHERE t.path NOT LIKE 'drizzle/migrations/meta/%'
     AND t.path <> 'src/integrations/supabase/types.ts'
     AND t.path <> 'scripts/schema-types.fingerprint.json'
     AND t.path NOT LIKE 'public/sitemap%'
     AND t.path NOT LIKE '.lovable/%'
  WINDOW w AS (PARTITION BY t.path ORDER BY t.touched_at, t.created_at)
)
SELECT b.window_id, b.evidence_ref, b.path, b.engineer_id, b.touched_at, b.blob_sha, b.prev_blob,
       CASE
         WHEN r.evidence_ref IS NOT NULL THEN 'reverted'
         WHEN u.evidence_ref IS NOT NULL THEN 'is_revert'
         WHEN b.prev_blob IS NULL THEN 'unknown_prior'
         ELSE 'survives'
       END AS status,
       r.evidence_ref AS reverted_by_ref,
       r.engineer_id  AS reverted_by_engineer,
       CASE WHEN r.evidence_ref IS NULL THEN u.evidence_ref END AS undid_ref,
       CASE WHEN r.evidence_ref IS NULL THEN u.engineer_id END AS undid_engineer
  FROM b
  LEFT JOIN LATERAL (
    SELECT l.evidence_ref, l.engineer_id FROM b l
     WHERE l.path = b.path AND l.seq > b.seq
       AND b.prev_blob IS NOT NULL AND l.blob_sha = b.prev_blob
     ORDER BY l.seq LIMIT 1
  ) r ON true
  LEFT JOIN LATERAL (
    SELECT e.evidence_ref, e.engineer_id FROM b e
     WHERE e.path = b.path AND e.seq < b.seq - 1
       AND e.blob_sha = b.blob_sha
       AND b.blob_sha IS DISTINCT FROM b.prev_blob
     ORDER BY e.seq DESC LIMIT 1
  ) u ON true;

CREATE VIEW public.engrep_commit_survival WITH (security_invoker = on) AS
WITH agg AS (
  SELECT s.evidence_ref,
         (array_agg(s.engineer_id ORDER BY s.touched_at))[1] AS engineer_id,
         count(*) AS files,
         count(*) FILTER (WHERE s.status = 'reverted')  AS files_reverted,
         count(*) FILTER (WHERE s.status = 'is_revert') AS files_is_revert
    FROM public.engrep_file_survival s
   GROUP BY s.evidence_ref
)
SELECT a.evidence_ref, a.engineer_id, a.files, a.files_reverted, a.files_is_revert,
       CASE
         WHEN a.files_reverted = a.files THEN 'undone'
         WHEN a.files_is_revert = a.files THEN 'undo'
         WHEN a.files_reverted > 0 OR a.files_is_revert > 0 THEN 'mixed'
         ELSE 'live'
       END AS survival,
       (a.files_is_revert = a.files AND EXISTS (
          SELECT 1 FROM public.engrep_file_survival v
           WHERE v.reverted_by_ref = a.evidence_ref
             AND v.engineer_id = a.engineer_id)) AS same_owner_churn
  FROM agg a;

REVOKE ALL ON public.engrep_file_survival FROM anon, public;
REVOKE ALL ON public.engrep_commit_survival FROM anon, public;
GRANT SELECT ON public.engrep_file_survival TO authenticated;
GRANT SELECT ON public.engrep_commit_survival TO authenticated;