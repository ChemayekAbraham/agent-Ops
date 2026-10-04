CREATE TABLE public.house_share_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  listing_id uuid NOT NULL,
  share_method text NOT NULL CHECK (share_method IN ('native','whatsapp','copy')),
  short_code text,
  user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_house_share_events_listing ON public.house_share_events (listing_id);
CREATE INDEX idx_house_share_events_created ON public.house_share_events (created_at DESC);

GRANT INSERT ON public.house_share_events TO anon, authenticated;
GRANT SELECT ON public.house_share_events TO authenticated;
GRANT ALL ON public.house_share_events TO service_role;

ALTER TABLE public.house_share_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can record a share event"
  ON public.house_share_events FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Ops can view share events"
  ON public.house_share_events FOR SELECT
  TO authenticated
  USING (public.is_ops_role(auth.uid()));