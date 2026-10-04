
CREATE TABLE public.install_attempt_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  platform text,
  in_app_browser boolean,
  in_app_browser_name text,
  is_standalone boolean,
  display_mode text,
  ios_version int,
  user_agent text,
  url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_install_attempt_events_created_at ON public.install_attempt_events (created_at DESC);
CREATE INDEX idx_install_attempt_events_event_type ON public.install_attempt_events (event_type);
CREATE INDEX idx_install_attempt_events_user_id ON public.install_attempt_events (user_id);

GRANT SELECT, INSERT ON public.install_attempt_events TO authenticated;
GRANT INSERT ON public.install_attempt_events TO anon;
GRANT ALL ON public.install_attempt_events TO service_role;

ALTER TABLE public.install_attempt_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can log install attempts"
  ON public.install_attempt_events
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (user_id IS NULL OR user_id = auth.uid());

CREATE POLICY "Users see own install attempts"
  ON public.install_attempt_events
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Ops roles see all install attempts"
  ON public.install_attempt_events
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'cmo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'manager')
  );
