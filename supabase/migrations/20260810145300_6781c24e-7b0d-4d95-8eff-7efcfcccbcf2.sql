ALTER TABLE public.lc1_chairpersons
  ADD COLUMN IF NOT EXISTS ug_village_id integer NULL REFERENCES public.ug_villages(id);

CREATE INDEX IF NOT EXISTS idx_lc1_chairpersons_ug_village_id
  ON public.lc1_chairpersons (ug_village_id);