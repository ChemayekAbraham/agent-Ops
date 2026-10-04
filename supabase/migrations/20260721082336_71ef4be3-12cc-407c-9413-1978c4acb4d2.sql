
CREATE POLICY "Finance leaders read requisition attachments"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'requisition-attachments'
    AND (
      public.has_role(auth.uid(), 'cfo')
      OR public.has_role(auth.uid(), 'super_admin')
      OR public.has_role(auth.uid(), 'manager')
    )
  );
