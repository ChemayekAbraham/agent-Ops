ALTER TABLE public.house_listings_region_normalization_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ops_can_read_region_normalization_log"
ON public.house_listings_region_normalization_log
FOR SELECT
TO authenticated
USING (public.is_ops_role(auth.uid()));