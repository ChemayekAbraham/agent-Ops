
-- Private storage bucket for database backups
INSERT INTO storage.buckets (id, name, public)
VALUES ('db-backups', 'db-backups', false)
ON CONFLICT (id) DO NOTHING;

-- Manager-only access to the bucket
CREATE POLICY "Managers can read db backups"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'db-backups' AND public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Managers can insert db backups"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'db-backups' AND public.has_role(auth.uid(), 'manager'));

-- Audit table for backup runs
CREATE TABLE IF NOT EXISTS public.backup_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_path TEXT,
  size_bytes BIGINT,
  table_count INT,
  row_count BIGINT,
  status TEXT NOT NULL DEFAULT 'success',
  error_message TEXT,
  recipients TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.backup_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers can view backup runs"
ON public.backup_runs FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'manager'));
