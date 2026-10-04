
CREATE TABLE IF NOT EXISTS public.analytics_export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL,                 -- 'user_analytics_csv' | 'user_analytics_pdf'
  status text NOT NULL DEFAULT 'queued', -- queued|running|succeeded|failed
  progress int NOT NULL DEFAULT 0,       -- 0-100
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  file_path text,                      -- storage object path in analytics-exports bucket
  row_count int,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

GRANT SELECT, INSERT ON public.analytics_export_jobs TO authenticated;
GRANT ALL ON public.analytics_export_jobs TO service_role;

ALTER TABLE public.analytics_export_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "requester or staff can read"
  ON public.analytics_export_jobs FOR SELECT TO authenticated
  USING (
    requested_by = auth.uid()
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'cmo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'manager')
  );

CREATE POLICY "requester creates own job"
  ON public.analytics_export_jobs FOR INSERT TO authenticated
  WITH CHECK (requested_by = auth.uid());

CREATE INDEX IF NOT EXISTS idx_analytics_export_jobs_requester_created
  ON public.analytics_export_jobs (requested_by, created_at DESC);

CREATE OR REPLACE FUNCTION public._touch_analytics_export_jobs()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_touch_analytics_export_jobs ON public.analytics_export_jobs;
CREATE TRIGGER trg_touch_analytics_export_jobs
  BEFORE UPDATE ON public.analytics_export_jobs
  FOR EACH ROW EXECUTE FUNCTION public._touch_analytics_export_jobs();
