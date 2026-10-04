
-- Add house_category column to landlords table for property classification
ALTER TABLE public.landlords
  ADD COLUMN IF NOT EXISTS house_category TEXT DEFAULT 'single_room';

-- Add number_of_rooms if not exists  
ALTER TABLE public.landlords
  ADD COLUMN IF NOT EXISTS number_of_rooms INTEGER DEFAULT 1;

COMMENT ON COLUMN public.landlords.house_category IS 'Property category: single_room, double_room, self_contained, apartment, commercial';
