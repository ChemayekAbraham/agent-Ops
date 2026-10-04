
INSERT INTO storage.buckets (id, name, public)
VALUES ('business-advance-documents', 'business-advance-documents', false)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.business_advance_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id UUID NOT NULL REFERENCES public.business_advances(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  uploaded_by UUID NOT NULL,
  stage_key TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size BIGINT,
  content_type TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ba_docs_advance ON public.business_advance_documents(advance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ba_docs_tenant ON public.business_advance_documents(tenant_id, created_at DESC);

ALTER TABLE public.business_advance_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenants view own advance documents"
  ON public.business_advance_documents FOR SELECT
  USING (auth.uid() = tenant_id);

CREATE POLICY "Tenants upload own advance documents"
  ON public.business_advance_documents FOR INSERT
  WITH CHECK (
    auth.uid() = tenant_id
    AND auth.uid() = uploaded_by
    AND EXISTS (SELECT 1 FROM public.business_advances ba WHERE ba.id = advance_id AND ba.tenant_id = auth.uid())
  );

CREATE POLICY "Tenants delete own advance documents"
  ON public.business_advance_documents FOR DELETE
  USING (auth.uid() = tenant_id);

CREATE POLICY "Staff view all advance documents"
  ON public.business_advance_documents FOR SELECT
  USING (
    public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'operations')
  );

CREATE POLICY "Tenants upload own advance docs to storage"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'business-advance-documents'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "Tenants read own advance docs from storage"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'business-advance-documents'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "Tenants delete own advance docs from storage"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'business-advance-documents'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "Staff read all advance docs from storage"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'business-advance-documents'
    AND (
      public.has_role(auth.uid(), 'manager')
      OR public.has_role(auth.uid(), 'coo')
      OR public.has_role(auth.uid(), 'cfo')
      OR public.has_role(auth.uid(), 'operations')
    )
  );
