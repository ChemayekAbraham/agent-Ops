ALTER TABLE public.landlords ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE public.landlords ADD COLUMN IF NOT EXISTS number_of_rooms integer;