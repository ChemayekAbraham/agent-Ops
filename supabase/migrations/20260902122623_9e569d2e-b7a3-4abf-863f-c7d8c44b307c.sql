ALTER TABLE public.employee_requisitions
  ADD COLUMN IF NOT EXISTS workflow_stage text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS current_approver_role text,
  ADD COLUMN IF NOT EXISTS coo_decided_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS coo_decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS coo_note text,
  ADD COLUMN IF NOT EXISTS approved_amount numeric(18,2);

ALTER TABLE public.employee_requisitions
  DROP CONSTRAINT IF EXISTS employee_requisitions_status_check;
ALTER TABLE public.employee_requisitions
  ADD CONSTRAINT employee_requisitions_status_check
  CHECK (status IN ('pending','pending_coo','pending_cfo','approved','rejected','paid','cancelled'));

ALTER TABLE public.employee_requisitions
  DROP CONSTRAINT IF EXISTS employee_requisitions_workflow_stage_check;
ALTER TABLE public.employee_requisitions
  ADD CONSTRAINT employee_requisitions_workflow_stage_check
  CHECK (workflow_stage IN ('legacy','coo','cfo','complete'));

GRANT SELECT ON public.employee_requisitions TO authenticated;
GRANT UPDATE ON public.employee_requisitions TO authenticated;
GRANT ALL ON public.employee_requisitions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.requisition_links TO authenticated;
GRANT ALL ON public.requisition_links TO service_role;

DROP POLICY IF EXISTS "Finance leaders manage requisition links" ON public.requisition_links;
CREATE POLICY "Financial Operations manage requisition links"
  ON public.requisition_links
  FOR ALL
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'operations')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'operations')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
  );

DROP POLICY IF EXISTS "Finance leaders view requisitions" ON public.employee_requisitions;
CREATE POLICY "Financial Operations view requisitions"
  ON public.employee_requisitions
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'operations')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
  );

CREATE INDEX IF NOT EXISTS idx_employee_requisitions_manual_stage
  ON public.employee_requisitions(workflow_stage, status, submitted_at DESC)
  WHERE link_id IS NOT NULL;