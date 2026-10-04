CREATE TABLE public.agent_subagent_link_archive (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  original_id uuid NOT NULL,
  parent_agent_id uuid NOT NULL,
  sub_agent_id uuid NOT NULL,
  source text NOT NULL,
  status text NOT NULL,
  original_created_at timestamptz NOT NULL,
  archive_reason text NOT NULL,
  archived_by uuid,
  archived_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_subagent_link_archive_parent ON public.agent_subagent_link_archive (parent_agent_id);
CREATE INDEX idx_subagent_link_archive_sub ON public.agent_subagent_link_archive (sub_agent_id);

GRANT SELECT ON public.agent_subagent_link_archive TO authenticated;
GRANT ALL ON public.agent_subagent_link_archive TO service_role;

ALTER TABLE public.agent_subagent_link_archive ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view archived sub-agent links"
ON public.agent_subagent_link_archive
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'operations')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'super_admin')
);