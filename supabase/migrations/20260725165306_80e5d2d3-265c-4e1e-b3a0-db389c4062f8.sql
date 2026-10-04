
CREATE TABLE IF NOT EXISTS public.login_phase_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NULL,
  session_trace_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NULL,
  ms_since_start INTEGER NULL,
  duration_ms INTEGER NULL,
  detail JSONB NULL,
  user_agent TEXT NULL,
  path TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_phase_events_user ON public.login_phase_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_phase_events_trace ON public.login_phase_events (session_trace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_login_phase_events_created ON public.login_phase_events (created_at DESC);

GRANT INSERT ON public.login_phase_events TO authenticated, anon;
GRANT USAGE, SELECT ON SEQUENCE public.login_phase_events_id_seq TO authenticated, anon;
GRANT ALL ON public.login_phase_events TO service_role;

ALTER TABLE public.login_phase_events ENABLE ROW LEVEL SECURITY;

-- Anyone (even unauthenticated during pre-login phases) can INSERT telemetry
-- for their own trace. No reads are exposed to end users; only ops (via
-- service_role / SQL analytics) inspect the data.
CREATE POLICY "telemetry insert own"
  ON public.login_phase_events
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    user_id IS NULL OR user_id = auth.uid()
  );

-- 14-day retention (aligns with existing log retention policy)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge_login_phase_events') THEN
    PERFORM cron.schedule(
      'purge_login_phase_events',
      '17 3 * * *',
      $CRON$DELETE FROM public.login_phase_events WHERE created_at < now() - interval '14 days'$CRON$
    );
  END IF;
END $$;
