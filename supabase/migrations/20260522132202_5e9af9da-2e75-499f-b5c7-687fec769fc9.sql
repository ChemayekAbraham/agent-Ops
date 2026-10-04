ALTER TABLE public.house_listings ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_house_listings_is_hidden ON public.house_listings(is_hidden);