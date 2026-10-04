-- RLS policies for the private 'partner-agreements' bucket.
CREATE POLICY "Authenticated can upload partner agreements"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'partner-agreements');

CREATE POLICY "Authenticated can update partner agreements"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'partner-agreements')
WITH CHECK (bucket_id = 'partner-agreements');

CREATE POLICY "Authenticated can read partner agreements"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'partner-agreements');
