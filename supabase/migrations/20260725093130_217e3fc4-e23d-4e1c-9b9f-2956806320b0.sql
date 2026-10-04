
CREATE POLICY "analytics-exports owner read"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'analytics-exports'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "analytics-exports staff read"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'analytics-exports'
    AND (
      public.has_role(auth.uid(), 'super_admin')
      OR public.has_role(auth.uid(), 'ceo')
      OR public.has_role(auth.uid(), 'cmo')
      OR public.has_role(auth.uid(), 'coo')
      OR public.has_role(auth.uid(), 'cto')
      OR public.has_role(auth.uid(), 'cfo')
      OR public.has_role(auth.uid(), 'manager')
    )
  );
