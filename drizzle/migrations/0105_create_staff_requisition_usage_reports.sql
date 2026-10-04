CREATE TABLE public.staff_requisition_usage_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id uuid NOT NULL REFERENCES public.staff_requisitions(id) ON DELETE CASCADE,
  requester_id uuid NOT NULL,
  amount_used numeric NOT NULL CHECK (amount_used >= 0),
  summary text NOT NULL CHECK (char_length(btrim(summary)) >= 20),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX staff_requisition_usage_reports_req_uniq
  ON public.staff_requisition_usage_reports(requisition_id);
CREATE INDEX staff_requisition_usage_reports_requester_idx
  ON public.staff_requisition_usage_reports(requester_id);

GRANT SELECT, INSERT ON public.staff_requisition_usage_reports TO authenticated;
GRANT ALL ON public.staff_requisition_usage_reports TO service_role;

ALTER TABLE public.staff_requisition_usage_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "requester submits own usage report"
ON public.staff_requisition_usage_reports
FOR INSERT
TO authenticated
WITH CHECK (
  requester_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.staff_requisitions r
    WHERE r.id = staff_requisition_usage_reports.requisition_id
      AND r.requester_id = auth.uid()
      AND r.stage = 'approved'
  )
);

CREATE POLICY "requester reads own usage report"
ON public.staff_requisition_usage_reports
FOR SELECT
TO authenticated
USING (requester_id = auth.uid());

CREATE POLICY "staff read usage reports"
ON public.staff_requisition_usage_reports
FOR SELECT
TO authenticated
USING (public.is_welile_staff(auth.uid()));
