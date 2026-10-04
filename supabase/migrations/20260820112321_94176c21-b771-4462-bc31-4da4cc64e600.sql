ALTER TABLE public.hr_task_attachments
  DROP CONSTRAINT hr_task_attachments_mime_type_allowlist;

ALTER TABLE public.hr_task_attachments
  ADD CONSTRAINT hr_task_attachments_mime_type_allowlist
  CHECK (mime_type = ANY (ARRAY[
    'image/jpeg'::text,
    'image/png'::text,
    'image/webp'::text,
    'image/heic'::text,
    'application/pdf'::text,
    'video/mp4'::text,
    'video/webm'::text,
    'video/quicktime'::text
  ]));

ALTER TABLE public.hr_task_attachments
  DROP CONSTRAINT hr_task_attachments_size_bytes_max;

ALTER TABLE public.hr_task_attachments
  ADD CONSTRAINT hr_task_attachments_size_bytes_max
  CHECK (
    size_bytes > 0
    AND (
      CASE
        WHEN mime_type LIKE 'video/%' THEN size_bytes <= 52428800
        ELSE size_bytes <= 10485760
      END
    )
  );

ALTER TABLE public.hr_task_attachments
  ADD COLUMN file_name text;

ALTER TABLE public.hr_task_attachments
  ADD CONSTRAINT hr_task_attachments_retention
  CHECK (delete_after IS NULL OR delete_after > (uploaded_at)::date);