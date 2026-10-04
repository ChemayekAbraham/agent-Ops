CREATE OR REPLACE VIEW public.engrep_file_survival WITH (security_invoker = on) AS
 WITH b AS (
         SELECT t.window_id, t.evidence_ref, t.path, t.engineer_id, t.touched_at, t.created_at, t.blob_sha,
            lag(t.blob_sha) OVER w AS prev_blob,
            row_number() OVER w AS seq,
            last_value(t.blob_sha) OVER (PARTITION BY t.path ORDER BY t.touched_at, t.created_at ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS latest_blob
           FROM engrep_file_touches t
          WHERE t.path !~~ 'drizzle/migrations/meta/%' AND t.path <> 'src/integrations/supabase/types.ts' AND t.path <> 'scripts/schema-types.fingerprint.json' AND t.path !~~ 'public/sitemap%' AND t.path !~~ '.lovable/%'
          WINDOW w AS (PARTITION BY t.path ORDER BY t.touched_at, t.created_at)
        ), c AS (
         SELECT b.*,
            min(CASE WHEN b.blob_sha = b.latest_blob THEN b.seq END) OVER (PARTITION BY b.path) AS latest_first_seq,
            min(CASE WHEN b.blob_sha = b.latest_blob THEN b.seq END) OVER (PARTITION BY b.path ORDER BY b.seq DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS next_latest_seq,
            CASE WHEN b.blob_sha IS NOT NULL THEN lag(b.seq) OVER (PARTITION BY b.path, b.blob_sha ORDER BY b.seq) END AS prior_same_seq
           FROM b
        ), d AS (
         SELECT c.*,
            (c.latest_blob IS NOT NULL AND c.blob_sha IS DISTINCT FROM c.latest_blob AND c.latest_first_seq < c.seq) AS is_reverted,
            (c.prior_same_seq IS NOT NULL AND c.prior_same_seq < c.seq - 1 AND c.blob_sha IS DISTINCT FROM c.prev_blob) AS is_undo
           FROM c
        )
 SELECT d.window_id, d.evidence_ref, d.path, d.engineer_id, d.touched_at, d.blob_sha, d.prev_blob,
        CASE WHEN d.is_reverted THEN 'reverted'::text
             WHEN d.is_undo THEN 'is_revert'::text
             WHEN d.prev_blob IS NULL THEN 'unknown_prior'::text
             ELSE 'survives'::text END AS status,
    r.evidence_ref AS reverted_by_ref,
    r.engineer_id AS reverted_by_engineer,
    CASE WHEN NOT d.is_reverted AND d.is_undo THEN u.evidence_ref ELSE NULL::text END AS undid_ref,
    CASE WHEN NOT d.is_reverted AND d.is_undo THEN u.engineer_id ELSE NULL::uuid END AS undid_engineer
   FROM d
     LEFT JOIN d r ON d.is_reverted AND r.path = d.path AND r.seq = d.next_latest_seq
     LEFT JOIN d u ON d.is_undo AND u.path = d.path AND u.seq = d.prior_same_seq;

CREATE OR REPLACE VIEW public.engrep_commit_survival WITH (security_invoker = on) AS
 WITH agg AS (
         SELECT s.evidence_ref,
            (array_agg(s.engineer_id ORDER BY s.touched_at))[1] AS engineer_id,
            count(*) AS files,
            count(*) FILTER (WHERE s.status = 'reverted'::text) AS files_reverted,
            count(*) FILTER (WHERE s.status = 'is_revert'::text) AS files_is_revert
           FROM engrep_file_survival s
          GROUP BY s.evidence_ref
        ), rb AS (
         SELECT DISTINCT v.reverted_by_ref, v.engineer_id FROM engrep_file_survival v WHERE v.reverted_by_ref IS NOT NULL
        )
 SELECT a.evidence_ref, a.engineer_id, a.files, a.files_reverted, a.files_is_revert,
        CASE WHEN a.files_reverted = a.files THEN 'undone'::text
             WHEN a.files_is_revert = a.files THEN 'undo'::text
             WHEN a.files_reverted > 0 OR a.files_is_revert > 0 THEN 'mixed'::text
             ELSE 'live'::text END AS survival,
    (a.files_is_revert = a.files AND EXISTS (SELECT 1 FROM rb WHERE rb.reverted_by_ref = a.evidence_ref AND rb.engineer_id = a.engineer_id)) AS same_owner_churn
   FROM agg a;