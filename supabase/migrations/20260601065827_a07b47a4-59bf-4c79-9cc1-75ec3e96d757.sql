ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS house_listing_id uuid REFERENCES public.house_listings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_rent_requests_house_listing_id
  ON public.rent_requests(house_listing_id);