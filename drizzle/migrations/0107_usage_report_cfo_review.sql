ALTER TABLE public.staff_requisition_usage_reports
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_note text;

ALTER TABLE public.staff_requisition_usage_reports
  DROP CONSTRAINT IF EXISTS staff_requisition_usage_reports_review_status_ck;

ALTER TABLE public.staff_requisition_usage_reports
  ADD CONSTRAINT staff_requisition_usage_reports_review_status_ck
  CHECK (review_status IN ('pending', 'accepted', 'clarification_requested'));

CREATE INDEX IF NOT EXISTS staff_requisition_usage_reports_review_status_idx
  ON public.staff_requisition_usage_reports (review_status, submitted_at DESC);

DROP POLICY IF EXISTS "finance reviewers update usage report review" ON public.staff_requisition_usage_reports;

CREATE POLICY "finance reviewers update usage report review"
  ON public.staff_requisition_usage_reports
  FOR UPDATE
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
  );

GRANT SELECT, INSERT, UPDATE ON public.staff_requisition_usage_reports TO authenticated;
GRANT ALL ON public.staff_requisition_usage_reports TO service_role;