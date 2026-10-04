ALTER TABLE public.house_listings
  ADD COLUMN IF NOT EXISTS ug_village_id integer NULL;

CREATE INDEX IF NOT EXISTS idx_house_listings_ug_village_id
  ON public.house_listings(ug_village_id);

COMMENT ON COLUMN public.house_listings.ug_village_id IS
  'Optional FK-style reference to ug_villages.id — the official Uganda administrative village selected via UgLocationPicker. Names remain mirrored in region/district/sub_county/village.';