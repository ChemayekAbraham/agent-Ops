CREATE TABLE public.browser_compat_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL,
  user_agent text,
  missing_features text[] NOT NULL DEFAULT '{}',
  device jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  load_ms integer
);

CREATE INDEX idx_browser_compat_events_created_at ON public.browser_compat_events (created_at DESC);
CREATE INDEX idx_browser_compat_events_type ON public.browser_compat_events (event_type);

GRANT SELECT, INSERT ON public.browser_compat_events TO anon;
GRANT SELECT, INSERT ON public.browser_compat_events TO authenticated;
GRANT ALL ON public.browser_compat_events TO service_role;

ALTER TABLE public.browser_compat_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can insert browser compat events"
  ON public.browser_compat_events
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Managers can view browser compat events"
  ON public.browser_compat_events
  FOR SELECT
  TO authenticated
  USING (
    has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'cto'::app_role)
  );