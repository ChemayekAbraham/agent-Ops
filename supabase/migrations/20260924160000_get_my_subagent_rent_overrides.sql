-- Sub-agent rent-override earnings for the calling agent, grouped by the
-- sub-agent whose collection produced them.
--
-- The recruiter's % override on a sub-agent's rent collection is posted to
-- general_ledger (wallet, cash_in, source_table 'agent_collections',
-- source_id = the sub-agent's rent plan). To attribute it per sub-agent the
-- client had to read the sub-agents' rent_requests, but rent_requests RLS only
-- exposes a handful of them to the parent (agent Oscar Arnold, 2026-09-24:
-- 4 of 30 visible, while his 89 overrides came from 12 plans). So the
-- sub-agents list showed his 2% as zero. This does the join server-side,
-- strictly for auth.uid()'s own ledger credits and own direct sub-agents.
-- Read-only; returns nothing about money the caller didn't receive.

CREATE OR REPLACE FUNCTION public.get_my_subagent_rent_overrides(
  p_from timestamptz DEFAULT NULL,
  p_to   timestamptz DEFAULT NULL
)
RETURNS TABLE(sub_agent_id uuid, amount numeric, credits integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT rr.agent_id AS sub_agent_id,
         SUM(g.amount) AS amount,
         COUNT(*)::integer AS credits
  FROM public.general_ledger g
  JOIN public.rent_requests rr ON rr.id::text = g.source_id::text
  WHERE auth.uid() IS NOT NULL
    AND g.user_id = auth.uid()
    AND g.ledger_scope = 'wallet'
    AND g.direction IN ('credit', 'cash_in')
    AND g.source_table = 'agent_collections'
    AND g.description ILIKE '%override%'
    AND COALESCE(g.classification, '') <> 'admin_correction'
    AND (p_from IS NULL OR g.created_at >= p_from)
    AND (p_to IS NULL OR g.created_at <= p_to)
    AND EXISTS (
      SELECT 1 FROM public.agent_subagents s
      WHERE s.parent_agent_id = auth.uid() AND s.sub_agent_id = rr.agent_id
    )
  GROUP BY rr.agent_id;
$$;

REVOKE ALL ON FUNCTION public.get_my_subagent_rent_overrides(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_subagent_rent_overrides(timestamptz, timestamptz) TO authenticated;
