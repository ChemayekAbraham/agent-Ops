ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS category text;
CREATE INDEX IF NOT EXISTS idx_vendors_category ON public.vendors(category) WHERE active = true;