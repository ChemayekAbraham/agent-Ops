-- Departments a user may file a budget for (mirrors the read/selection scope used by the UI).
CREATE OR REPLACE FUNCTION public.budget_can_file_for_department(_user_id uuid, _department_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _user_id IS NOT NULL
     AND _department_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.budget_user_department_ids(_user_id) AS d(id)
        WHERE d.id = _department_id
     );
$$;

GRANT EXECUTE ON FUNCTION public.budget_can_file_for_department(uuid, uuid) TO authenticated;

-- Write scope: allow filing for ANY registered department of the caller
-- (an Ops hub staffer filing for tenant_ops/agent_ops/landlord_ops/partner_ops),
-- instead of only the single "home" HR department, which forced Ops budgets
-- under direct-route departments and thereby skipped the COO stage.
CREATE OR REPLACE FUNCTION public.budget_save_draft(
  p_submission_id uuid,
  p_call_id uuid,
  p_department_id uuid,
  p_title text,
  p_purpose text,
  p_lines jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid := p_submission_id;
  v_call budget_calls;
  v_status text;
  v_total numeric := 0;
  v_line jsonb;
  v_idx int := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  IF v_id IS NULL THEN
    IF p_department_id IS NULL THEN
      RAISE EXCEPTION 'A registered HR department is required for a budget';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM hr_departments d WHERE d.id = p_department_id AND d.active) THEN
      RAISE EXCEPTION 'Department is not an active registered HR department';
    END IF;
    SELECT * INTO v_call FROM budget_calls WHERE id = p_call_id;
    IF v_call.id IS NULL THEN RAISE EXCEPTION 'Budget cycle not found'; END IF;
    IF v_call.status <> 'open' THEN RAISE EXCEPTION 'Budget cycle is not open'; END IF;

    IF NOT public.is_budget_reviewer(v_uid)
       AND NOT public.budget_can_file_for_department(v_uid, p_department_id) THEN
      RAISE EXCEPTION 'You can only budget for a department you are registered in';
    END IF;

    INSERT INTO budget_submissions(call_id, department_id, reference, title, purpose, status,
                                   period_type, period_start, period_end, submitted_by_user_id, total_amount)
    VALUES (p_call_id, p_department_id,
            'BGT-'||to_char(now(),'YYMMDD')||'-'||upper(substr(md5(random()::text),1,6)),
            p_title, p_purpose, 'draft',
            v_call.period_type, v_call.period_start, v_call.period_end, v_uid, 0)
    RETURNING id INTO v_id;
  ELSE
    SELECT status INTO v_status FROM budget_submissions WHERE id = v_id;
    IF v_status IS NULL THEN RAISE EXCEPTION 'Submission not found'; END IF;
    IF NOT public.can_access_budget_submission(v_id, v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;
    IF v_status <> 'draft' THEN RAISE EXCEPTION 'Submission is read-only in status %', v_status; END IF;
    IF NOT EXISTS (SELECT 1 FROM budget_calls bc JOIN budget_submissions bs ON bs.call_id = bc.id
                    WHERE bs.id = v_id AND bc.status = 'open') THEN
      RAISE EXCEPTION 'Budget cycle is not open';
    END IF;
    UPDATE budget_submissions SET title = p_title, purpose = p_purpose WHERE id = v_id;
  END IF;

  IF p_lines IS NOT NULL THEN
    DELETE FROM budget_submission_lines WHERE submission_id = v_id;
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
      v_idx := v_idx + 1;
      IF COALESCE(NULLIF(v_line->>'description',''), '') = '' THEN
        RAISE EXCEPTION 'Line % is missing a description', v_idx;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM ledger_account_catalog WHERE code = v_line->>'account_code') THEN
        RAISE EXCEPTION 'Line % has an invalid budget category (Chart of Accounts code)', v_idx;
      END IF;
      IF NOT public.budget_is_budgetable_account(v_line->>'account_code') THEN
        RAISE EXCEPTION 'Line % uses category % which is not a budgetable spending category', v_idx, v_line->>'account_code';
      END IF;
      INSERT INTO budget_submission_lines(submission_id, sort_order, description, category, account_code,
        quantity, unit_amount, period_month, justification, document_path, status)
      VALUES (v_id, v_idx, v_line->>'description', v_line->>'category', v_line->>'account_code',
        COALESCE((v_line->>'quantity')::numeric, 1), COALESCE((v_line->>'unit_amount')::numeric, 0),
        NULLIF(v_line->>'period_month','')::date, NULLIF(v_line->>'justification',''),
        NULLIF(v_line->>'document_path',''), 'pending');
      v_total := v_total + COALESCE((v_line->>'quantity')::numeric, 1) * COALESCE((v_line->>'unit_amount')::numeric, 0);
    END LOOP;
    UPDATE budget_submissions SET total_amount = v_total WHERE id = v_id;
  END IF;

  RETURN v_id;
END;
$fn$;

-- Read scope must match the write scope: any department the caller is
-- registered in (HR assignment or operations hub), plus own submissions.
CREATE OR REPLACE FUNCTION public.can_access_budget_submission(_submission_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_budget_reviewer(_user_id)
      OR EXISTS (
        SELECT 1 FROM budget_submissions bs
        WHERE bs.id = _submission_id
          AND (
            bs.submitted_by_user_id = _user_id
            OR public.budget_can_file_for_department(_user_id, bs.department_id)
            OR (public.is_budget_coo_reviewer(_user_id)
                AND public.budget_department_route(bs.department_id) = 'coo')
          )
      );
$$;

DROP POLICY IF EXISTS budget_submissions_read ON public.budget_submissions;
CREATE POLICY budget_submissions_read ON public.budget_submissions
FOR SELECT TO authenticated
USING (
  submitted_by_user_id = (SELECT auth.uid())
  OR public.budget_can_file_for_department((SELECT auth.uid()), department_id)
  OR public.is_budget_reviewer((SELECT auth.uid()))
  OR (public.is_budget_coo_reviewer((SELECT auth.uid()))
      AND public.budget_department_route(department_id) = 'coo')
);