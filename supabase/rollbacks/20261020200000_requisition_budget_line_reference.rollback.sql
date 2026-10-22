-- Rollback for 20261020200000_requisition_budget_line_reference.sql
-- Removes the budget-line reference, its checks and the CFO switch. Requisitions themselves, their
-- statuses, approvals and wallet credits are untouched. Dropping the columns loses which budget line
-- each requisition referenced; export it first if that history is needed:
--   SELECT 'staff' t, id, budget_line_id FROM staff_requisitions WHERE budget_line_id IS NOT NULL
--   UNION ALL SELECT 'employee', id, budget_line_id FROM employee_requisitions WHERE budget_line_id IS NOT NULL
--   UNION ALL SELECT 'director', id, budget_line_id FROM director_requisitions WHERE budget_line_id IS NOT NULL;

-- ORDER: roll back 20261020210000_budget_payables FIRST — its views read budget_line_id.
SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF to_regclass('public.v_budget_payables_lines') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: roll back 20261020210000_budget_payables before this migration';
  END IF;
END
$pre$;

DROP TRIGGER IF EXISTS trg_requisition_budget_line_guard ON public.staff_requisitions;
DROP TRIGGER IF EXISTS trg_requisition_budget_line_guard ON public.employee_requisitions;
DROP TRIGGER IF EXISTS trg_requisition_budget_line_guard ON public.director_requisitions;
DROP TRIGGER IF EXISTS trg_budget_line_in_use_guard ON public.budget_submission_lines;
DROP FUNCTION IF EXISTS public.trg_budget_line_in_use_guard();

DROP FUNCTION IF EXISTS public.set_requisition_budget_line_required_from(timestamptz);
DROP FUNCTION IF EXISTS public.requisition_budget_lines_available(uuid);
DROP FUNCTION IF EXISTS public.trg_requisition_budget_line_guard();
DROP FUNCTION IF EXISTS public.requisition_budget_line_evaluate(uuid, numeric, date, uuid[], text, uuid, boolean);
DROP FUNCTION IF EXISTS public.requisition_budget_line_committed(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.requisition_budget_line_supplements(uuid);
DROP FUNCTION IF EXISTS public.requisition_budget_line_required_from();

DROP INDEX IF EXISTS public.budget_supplements_line_idx;
DROP INDEX IF EXISTS public.staff_requisitions_budget_line_idx;
DROP INDEX IF EXISTS public.employee_requisitions_budget_line_idx;
DROP INDEX IF EXISTS public.director_requisitions_budget_line_idx;

ALTER TABLE public.staff_requisitions    DROP COLUMN IF EXISTS budget_line_id;
ALTER TABLE public.employee_requisitions DROP COLUMN IF EXISTS budget_line_id;
ALTER TABLE public.director_requisitions DROP COLUMN IF EXISTS budget_line_id;

DELETE FROM public.system_config WHERE key = 'requisition_budget_line_required_from';

RESET lock_timeout;
