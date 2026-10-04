CREATE TABLE IF NOT EXISTS public.client_error_reports (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID,
  role TEXT,
  label TEXT,
  route TEXT,
  message TEXT,
  component_stack TEXT,
  user_agent TEXT,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_error_reports_created_at
  ON public.client_error_reports (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_error_reports_user
  ON public.client_error_reports (user_id);

ALTER TABLE public.client_error_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can insert their own error reports"
  ON public.client_error_reports
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id IS NULL OR user_id = auth.uid());

CREATE POLICY "Managers can view all client error reports"
  ON public.client_error_reports
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'manager'));