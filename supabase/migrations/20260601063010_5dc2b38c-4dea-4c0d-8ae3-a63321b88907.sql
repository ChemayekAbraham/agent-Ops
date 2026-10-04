ALTER TABLE public.supporter_invites
  ADD COLUMN IF NOT EXISTS house_listing_id uuid REFERENCES public.house_listings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_supporter_invites_house_listing_id
  ON public.supporter_invites(house_listing_id)
  WHERE house_listing_id IS NOT NULL;