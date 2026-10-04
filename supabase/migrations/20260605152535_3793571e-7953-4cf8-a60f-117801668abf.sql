CREATE TABLE IF NOT EXISTS public.drive_archive_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  doc_type text NOT NULL,
  source_bucket text NOT NULL,
  source_path text NOT NULL,
  file_name text,
  file_size bigint,
  drive_file_id text,
  drive_file_link text,
  drive_folder_path text,
  status text NOT NULL DEFAULT 'success',
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_drive_archive_log_user ON public.drive_archive_log (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_drive_archive_source ON public.drive_archive_log (source_bucket, source_path);

GRANT SELECT ON public.drive_archive_log TO authenticated;
GRANT ALL ON public.drive_archive_log TO service_role;

ALTER TABLE public.drive_archive_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own drive archive rows readable"
  ON public.drive_archive_log FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager'));