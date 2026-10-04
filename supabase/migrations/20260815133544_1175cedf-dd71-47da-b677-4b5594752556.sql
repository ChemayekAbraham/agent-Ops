DROP POLICY IF EXISTS "budget docs read" ON storage.objects;
CREATE POLICY "budget docs read" ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'budget-documents' AND (
    owner = (SELECT auth.uid())
    OR public.is_budget_reviewer((SELECT auth.uid()))
    OR EXISTS (
      SELECT 1 FROM public.budget_submission_documents d
      WHERE d.storage_path = storage.objects.name
        AND public.can_access_budget_submission(d.submission_id, (SELECT auth.uid()))
    )
  )
);
DROP POLICY IF EXISTS "budget docs insert" ON storage.objects;
CREATE POLICY "budget docs insert" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'budget-documents' AND owner = (SELECT auth.uid()));
DROP POLICY IF EXISTS "budget docs delete" ON storage.objects;
CREATE POLICY "budget docs delete" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'budget-documents' AND (owner = (SELECT auth.uid()) OR public.is_budget_reviewer((SELECT auth.uid()))));