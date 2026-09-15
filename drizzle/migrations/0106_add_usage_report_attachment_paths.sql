ALTER TABLE public.staff_requisition_usage_reports
  ADD COLUMN IF NOT EXISTS attachment_paths text[];