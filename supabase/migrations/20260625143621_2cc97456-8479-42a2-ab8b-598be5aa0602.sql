CREATE TABLE public.mission_publish_audit (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  mission_id uuid REFERENCES public.dashboard_missions(id) ON DELETE SET NULL,
  dashboard_role text NOT NULL,
  period_month date NOT NULL,
  mission text,
  goals_count integer NOT NULL DEFAULT 0,
  posted_by_name text,
  published_by uuid,
  published_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.mission_publish_audit TO authenticated;
GRANT ALL ON public.mission_publish_audit TO service_role;

ALTER TABLE public.mission_publish_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Executives can view mission publish audit"
ON public.mission_publish_audit
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'ceo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'cto'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
);

CREATE POLICY "Authenticated can record mission publish audit"
ON public.mission_publish_audit
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = published_by);

CREATE INDEX idx_mission_publish_audit_published_at ON public.mission_publish_audit (published_at DESC);
CREATE INDEX idx_mission_publish_audit_role_period ON public.mission_publish_audit (dashboard_role, period_month);