
CREATE POLICY "finops_read_reports_objects"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'finops-reports'
  AND (
    public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'financial_ops'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
  )
);
