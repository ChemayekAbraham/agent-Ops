CREATE TABLE public.update_failure_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  event_type TEXT NOT NULL,
  chunk_mismatch BOOLEAN,
  reload_attempts INTEGER,
  sw_cleared BOOLEAN,
  cache_cleared BOOLEAN,
  is_ios BOOLEAN,
  is_safari BOOLEAN,
  is_standalone BOOLEAN,
  ios_version TEXT,
  safari_version TEXT,
  user_agent TEXT,
  url TEXT,
  session_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_update_failure_events_created_at ON public.update_failure_events (created_at DESC);
CREATE INDEX idx_update_failure_events_event_type ON public.update_failure_events (event_type);

-- Telemetry is written by anonymous, possibly-unauthenticated stuck devices,
-- so anon needs INSERT. Reads are restricted to managers only.
GRANT INSERT ON public.update_failure_events TO anon, authenticated;
GRANT SELECT ON public.update_failure_events TO authenticated;
GRANT ALL ON public.update_failure_events TO service_role;

ALTER TABLE public.update_failure_events ENABLE ROW LEVEL SECURITY;

-- Anyone (even pre-auth devices) may log a telemetry event.
CREATE POLICY "Anyone can log update-failure telemetry"
ON public.update_failure_events
FOR INSERT
TO anon, authenticated
WITH CHECK (true);

-- Only managers can read the telemetry.
CREATE POLICY "Managers can read update-failure telemetry"
ON public.update_failure_events
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'manager'));