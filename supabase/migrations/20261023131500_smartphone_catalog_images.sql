-- Product photo per smartphone model, shown on the agent's phone cards.
--
-- * smartphone_catalog.image_url: storage URL of the model's photo (null = placeholder card).
--   Existing RLS on the table already limits writes to the catalog roles.
-- * Storage: photos live in the existing private 'merchandise' bucket under 'smartphones/'.
--   Reads are already open to authenticated users (bucket policy "Merchandise images readable
--   by authenticated"). Writes there were limited to cmo/manager/super_admin, so the catalog
--   roles (the same roles as the "Ops can manage catalog" table policy) get insert/update/delete
--   on the 'smartphones/' folder only.

ALTER TABLE public.smartphone_catalog ADD COLUMN IF NOT EXISTS image_url text;

DROP POLICY IF EXISTS "Smartphone catalog photos managed by ops" ON storage.objects;
CREATE POLICY "Smartphone catalog photos managed by ops"
  ON storage.objects
  FOR ALL
  TO authenticated
  USING (
    bucket_id = 'merchandise'
    AND (storage.foldername(name))[1] = 'smartphones'
    AND (
      public.has_role(auth.uid(), 'agent_ops'::app_role)
      OR public.has_role(auth.uid(), 'operations'::app_role)
      OR public.has_role(auth.uid(), 'coo'::app_role)
      OR public.has_role(auth.uid(), 'ceo'::app_role)
      OR public.has_role(auth.uid(), 'manager'::app_role)
      OR public.has_role(auth.uid(), 'admin'::app_role)
      OR public.has_role(auth.uid(), 'super_admin'::app_role)
    )
  )
  WITH CHECK (
    bucket_id = 'merchandise'
    AND (storage.foldername(name))[1] = 'smartphones'
    AND (
      public.has_role(auth.uid(), 'agent_ops'::app_role)
      OR public.has_role(auth.uid(), 'operations'::app_role)
      OR public.has_role(auth.uid(), 'coo'::app_role)
      OR public.has_role(auth.uid(), 'ceo'::app_role)
      OR public.has_role(auth.uid(), 'manager'::app_role)
      OR public.has_role(auth.uid(), 'admin'::app_role)
      OR public.has_role(auth.uid(), 'super_admin'::app_role)
    )
  );
