-- Lightweight analytics for Business Advance public marketing funnel.
-- Tracks two events:
--   * 'whatsapp_share_click'      — user tapped the Share-on-WhatsApp button
--   * 'tracker_view'              — user landed on the public tracking page and the
--                                   live approval progress tracker rendered for them
-- Anonymous inserts are allowed (the tracking page is public). Reads are restricted
-- to operations staff so the funnel data stays internal.

CREATE TABLE IF NOT EXISTS public.business_advance_share_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   TEXT NOT NULL CHECK (event_type IN ('whatsapp_share_click','tracker_view','copy_link_click')),
  phone        TEXT,
  advance_id   UUID,
  user_id      UUID,
  user_agent   TEXT,
  referrer     TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ba_share_events_type_time
  ON public.business_advance_share_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ba_share_events_phone
  ON public.business_advance_share_events (phone);
CREATE INDEX IF NOT EXISTS idx_ba_share_events_advance
  ON public.business_advance_share_events (advance_id);

ALTER TABLE public.business_advance_share_events ENABLE ROW LEVEL SECURITY;

-- Anyone (including unauthenticated visitors) can log an event. The table only
-- accepts a constrained event_type and never exposes data back to clients.
CREATE POLICY "anyone can log share events"
  ON public.business_advance_share_events
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- Only operations staff can read the funnel.
CREATE POLICY "ops can read share events"
  ON public.business_advance_share_events
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'operations')
  );