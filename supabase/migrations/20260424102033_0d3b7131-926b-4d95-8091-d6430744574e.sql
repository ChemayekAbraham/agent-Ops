-- Recreate the view with explicit security_invoker = true so it respects
-- the querying user's RLS context instead of the view creator's
DROP VIEW IF EXISTS public.agent_relationships;

CREATE VIEW public.agent_relationships
WITH (security_invoker = true) AS
SELECT
  id,
  parent_agent_id,
  sub_agent_id,
  status,
  source,
  verified_by  AS approved_by,
  verified_at  AS approved_at,
  rejection_reason,
  NULL::uuid        AS revoked_by,
  NULL::timestamptz AS revoked_at,
  created_at,
  created_at AS updated_at
FROM public.agent_subagents;

COMMENT ON VIEW public.agent_relationships IS
  'Read-only alias over agent_subagents with normalized column names (security_invoker = true so it respects the calling user RLS).';