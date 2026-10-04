CREATE POLICY "Agents upload own LC letters"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'lc-letters' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Agents view own LC letters"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'lc-letters' AND (
  (storage.foldername(name))[1] = auth.uid()::text
  OR public.is_ops_role(auth.uid())
  OR public.has_role(auth.uid(),'super_admin')
));

CREATE POLICY "Agents update own LC letters"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'lc-letters' AND (storage.foldername(name))[1] = auth.uid()::text);