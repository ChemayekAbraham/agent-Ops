-- Rolled-back verification for 20261020200000_requisition_budget_line_reference.sql
--
-- Run against the database AFTER the migration. Everything happens inside one block that ends in
-- RAISE EXCEPTION, so nothing is kept: no budget, requisition, notification or config change
-- survives. The error text IS the report: a JSON list of steps, each with "pass": true/false.
--
-- It builds its own weekly call, budget and lines (on a department routed straight to the CFO),
-- switches the mandatory rule on inside the transaction, and checks:
--   1  no line            -> BUDGET_LINE_REQUIRED          2  staff loan, no line -> accepted
--   3  growth commission  -> accepted                      4  valid line, own department -> accepted
--   5  second one over the line                            -> BUDGET_LINE_OVER_BUDGET
--   6  director + employee requisitions share the line's room (department check skipped)
--   7  a rejected director requisition frees its amount
--   8  line on a monthly call                               -> BUDGET_LINE_WRONG_WEEK
--   9  line on a budget still with the COO                  -> BUDGET_NOT_ON_CFO_DASHBOARD
--  10  line of another department                          -> BUDGET_LINE_OTHER_DEPARTMENT
--  11  line rejected by the CFO                             -> BUDGET_LINE_REJECTED
--  12  requisition_budget_lines_available lists the valid line with the right remaining amount
--  13  (B5) the picker refuses a department the caller may not file under
--  14  (B2) once a requisition is credited to a wallet, its budget line cannot change
--  15  the budget is returned; its referenced line cannot be removed      -> BUDGET_LINE_IN_USE
--  16  an unreferenced line of the returned budget can still be removed
--  17  a supplement still with the COO does not add room             -> BUDGET_LINE_OVER_BUDGET
--  18  a supplement that reached the CFO (pending_cfo) adds room, and the picker shows it
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_user uuid; v_dept uuid; v_other_dept uuid; v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_call uuid; v_call_m uuid; v_sub uuid; v_sub_coo uuid; v_sub_other uuid; v_sub_m uuid;
  v_line uuid; v_line_m uuid; v_line_coo uuid; v_line_other uuid; v_line_rej uuid;
  v_dir uuid; v_n int; v_rem numeric;
BEGIN
  -- a staff member who files requisitions, their own (routed) department, and one other department
  SELECT s.requester_id, s.department_id INTO v_user, v_dept
    FROM public.staff_requisitions s
   WHERE s.department_id IS NOT NULL AND public.is_welile_staff(s.requester_id)
     AND s.department_id IN (SELECT r.department_id FROM public.staff_requisition_route(s.requester_id) r
                             UNION SELECT public.budget_user_department_ids(s.requester_id))
   ORDER BY s.created_at DESC LIMIT 1;
  SELECT d.id INTO v_other_dept FROM public.hr_departments d
   WHERE d.id <> v_dept
     AND d.id NOT IN (SELECT r.department_id FROM public.staff_requisition_route(v_user) r WHERE r.department_id IS NOT NULL
                      UNION SELECT public.budget_user_department_ids(v_user))
   ORDER BY d.name LIMIT 1;

  INSERT INTO public.budget_calls (title, period_type, period_start, period_end, status, issued_by_user_id)
  VALUES ('TEST weekly (rolled back)', '5days', v_today, v_today + 6, 'open', v_user) RETURNING id INTO v_call;
  INSERT INTO public.budget_calls (title, period_type, period_start, period_end, status, issued_by_user_id)
  VALUES ('TEST monthly (rolled back)', 'monthly', v_today, v_today + 30, 'open', v_user) RETURNING id INTO v_call_m;

  INSERT INTO public.budget_submissions (call_id, reference, period_type, period_start, period_end, department_id, status, submitted_at)
  VALUES (v_call, 'TEST-BL-1', '5days', v_today, v_today + 6, v_dept, 'submitted', now()) RETURNING id INTO v_sub;
  INSERT INTO public.budget_submissions (call_id, reference, period_type, period_start, period_end, department_id, status, submitted_at)
  VALUES (v_call, 'TEST-BL-2', '5days', v_today, v_today + 6, v_dept, 'pending_coo', now()) RETURNING id INTO v_sub_coo;
  INSERT INTO public.budget_submissions (call_id, reference, period_type, period_start, period_end, department_id, status, submitted_at)
  VALUES (v_call, 'TEST-BL-3', '5days', v_today, v_today + 6, v_other_dept, 'submitted', now()) RETURNING id INTO v_sub_other;
  INSERT INTO public.budget_submissions (call_id, reference, period_type, period_start, period_end, department_id, status, submitted_at)
  VALUES (v_call_m, 'TEST-BL-4', 'monthly', v_today, v_today + 30, v_dept, 'submitted', now()) RETURNING id INTO v_sub_m;

  -- put the test budgets on the CFO dashboard whatever their department's route (COO-forwarded)
  UPDATE public.budget_submissions SET coo_reviewed_at = now() WHERE id IN (v_sub, v_sub_other, v_sub_m);
  INSERT INTO public.budget_submission_events (submission_id, event_type)
  VALUES (v_sub, 'coo_forwarded'), (v_sub_other, 'coo_forwarded'), (v_sub_m, 'coo_forwarded');

  INSERT INTO public.budget_submission_lines (submission_id, description, quantity, unit_amount) VALUES (v_sub, 'TEST line', 1, 100000) RETURNING id INTO v_line;
  INSERT INTO public.budget_submission_lines (submission_id, description, quantity, unit_amount, status) VALUES (v_sub, 'TEST rejected line', 1, 100000, 'rejected') RETURNING id INTO v_line_rej;
  INSERT INTO public.budget_submission_lines (submission_id, description, quantity, unit_amount) VALUES (v_sub_coo, 'TEST coo line', 1, 100000) RETURNING id INTO v_line_coo;
  INSERT INTO public.budget_submission_lines (submission_id, description, quantity, unit_amount) VALUES (v_sub_other, 'TEST other dept line', 1, 100000) RETURNING id INTO v_line_other;
  INSERT INTO public.budget_submission_lines (submission_id, description, quantity, unit_amount) VALUES (v_sub_m, 'TEST monthly line', 1, 100000) RETURNING id INTO v_line_m;

  -- switch the mandatory rule on (inside this transaction only)
  UPDATE public.system_config SET value = to_jsonb(now() - interval '1 minute') WHERE key = 'requisition_budget_line_required_from';

  -- helper: try one staff insert, record the outcome
  -- (each in its own sub-transaction so a refusal cannot affect the next step)
  BEGIN
    INSERT INTO public.staff_requisitions (requester_id, title, amount, reason, department_id, stage, current_approver_role, final_stage)
    VALUES (v_user, 'TEST no line', 1000, 'rolled-back verification', v_dept, 'coo', 'coo', 'cfo');
    r := r || jsonb_build_object('step', 1, 'pass', false, 'got', 'accepted');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('step', 1, 'pass', SQLERRM LIKE 'BUDGET_LINE_REQUIRED%', 'got', SQLERRM); END;

  BEGIN
    INSERT INTO public.staff_requisitions (requester_id, title, amount, reason, department_id, stage, current_approver_role, final_stage, request_kind, loan_months, loan_monthly_rate)
    VALUES (v_user, 'TEST loan', 1000, 'rolled-back verification', v_dept, 'coo', 'coo', 'cfo', 'staff_loan', 1, 0.28);
    r := r || jsonb_build_object('step', 2, 'pass', true);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('step', 2, 'pass', SQLERRM NOT LIKE 'BUDGET%', 'got', SQLERRM); END;

  BEGIN
    INSERT INTO public.staff_requisitions (requester_id, title, amount, reason, department_id, stage, current_approver_role, final_stage, category)
    VALUES (v_user, 'TEST commission', 1000, 'rolled-back verification', v_dept, 'coo', 'coo', 'cfo', 'growth_commission');
    r := r || jsonb_build_object('step', 3, 'pass', true);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('step', 3, 'pass', SQLERRM NOT LIKE 'BUDGET%', 'got', SQLERRM); END;

  BEGIN
    INSERT INTO public.staff_requisitions (requester_id, title, amount, reason, department_id, stage, current_approver_role, final_stage, budget_line_id)
    VALUES (v_user, 'TEST valid', 60000, 'rolled-back verification', v_dept, 'coo', 'coo', 'cfo', v_line);
    r := r || jsonb_build_object('step', 4, 'pass', true);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('step', 4, 'pass', false, 'got', SQLERRM); END;

  BEGIN
    INSERT INTO public.staff_requisitions (requester_id, title, amount, reason, department_id, stage, current_approver_role, final_stage, budget_line_id)
    VALUES (v_user, 'TEST over', 50000, 'rolled-back verification', v_dept, 'coo', 'coo', 'cfo', v_line);
    r := r || jsonb_build_object('step', 5, 'pass', false, 'got', 'accepted');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('step', 5, 'pass', SQLERRM LIKE 'BUDGET_LINE_OVER_BUDGET%', 'got', SQLERRM); END;

  BEGIN
    INSERT INTO public.director_requisitions (requester_id, title, amount, reason, budget_line_id)
    VALUES (v_user, 'TEST director', 30000, 'rolled-back verification', v_line) RETURNING id INTO v_dir;
    INSERT INTO public.employee_requisitions (employee_name, employee_email, purpose, category, amount, budget_line_id)
    VALUES ('TEST employee', 'test@example.com', 'rolled-back verification', 'Other', 10000, v_line);
    BEGIN
      INSERT INTO public.employee_requisitions (employee_name, employee_email, purpose, category, amount, budget_line_id)
      VALUES ('TEST employee 2', 'test2@example.com', 'rolled-back verification', 'Other', 1, v_line);
      r := r || jsonb_build_object('step', 6, 'pass', false, 'got', 'line should be full at 100,000');
    EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('step', 6, 'pass', SQLERRM LIKE 'BUDGET_LINE_OVER_BUDGET%', 'got', SQLERRM); END;
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('step', 6, 'pass', false, 'got', SQLERRM); END;

  BEGIN
    UPDATE public.director_requisitions SET status = 'rejected' WHERE id = v_dir;
    INSERT INTO public.employee_requisitions (employee_name, employee_email, purpose, category, amount, budget_line_id)
    VALUES ('TEST employee 3', 'test3@example.com', 'rolled-back verification', 'Other', 30000, v_line);
    r := r || jsonb_build_object('step', 7, 'pass', true);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('step', 7, 'pass', false, 'got', SQLERRM); END;

  BEGIN
    INSERT INTO public.director_requisitions (requester_id, title, amount, reason, budget_line_id) VALUES (v_user, 'TEST monthly', 1000, 'rolled-back verification', v_line_m);
    r := r || jsonb_build_object('step', 8, 'pass', false, 'got', 'accepted');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('step', 8, 'pass', SQLERRM LIKE 'BUDGET_LINE_WRONG_WEEK%', 'got', SQLERRM); END;

  BEGIN
    INSERT INTO public.director_requisitions (requester_id, title, amount, reason, budget_line_id) VALUES (v_user, 'TEST coo', 1000, 'rolled-back verification', v_line_coo);
    r := r || jsonb_build_object('step', 9, 'pass', false, 'got', 'accepted');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('step', 9, 'pass', SQLERRM LIKE 'BUDGET_NOT_ON_CFO_DASHBOARD%', 'got', SQLERRM); END;

  BEGIN
    INSERT INTO public.staff_requisitions (requester_id, title, amount, reason, department_id, stage, current_approver_role, final_stage, budget_line_id)
    VALUES (v_user, 'TEST other dept', 1000, 'rolled-back verification', v_dept, 'coo', 'coo', 'cfo', v_line_other);
    r := r || jsonb_build_object('step', 10, 'pass', false, 'got', 'accepted');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('step', 10, 'pass', SQLERRM LIKE 'BUDGET_LINE_OTHER_DEPARTMENT%', 'got', SQLERRM); END;

  BEGIN
    INSERT INTO public.director_requisitions (requester_id, title, amount, reason, budget_line_id) VALUES (v_user, 'TEST rejected line', 1000, 'rolled-back verification', v_line_rej);
    r := r || jsonb_build_object('step', 11, 'pass', false, 'got', 'accepted');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('step', 11, 'pass', SQLERRM LIKE 'BUDGET_LINE_REJECTED%', 'got', SQLERRM); END;

  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user)::text, true);
    SELECT count(*), max(remaining) FILTER (WHERE line_id = v_line) INTO v_n, v_rem
      FROM public.requisition_budget_lines_available(v_dept) WHERE line_id IN (v_line, v_line_rej, v_line_coo, v_line_m);
    -- only v_line qualifies; committed = 60,000 staff + 10,000 + 30,000 employee = 100,000 -> 0 left
    r := r || jsonb_build_object('step', 12, 'pass', v_n = 1 AND v_rem = 0, 'listed', v_n, 'remaining', v_rem);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('step', 12, 'pass', false, 'got', SQLERRM); END;

  BEGIN
    PERFORM 1 FROM public.requisition_budget_lines_available(v_other_dept);
    r := r || jsonb_build_object('step', 13, 'pass', false, 'got', 'listed another department');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('step', 13, 'pass', SQLERRM LIKE '%own department%', 'got', SQLERRM); END;

  BEGIN
    -- the 30,000 employee requisition from step 7 is credited, then someone tries to move it
    UPDATE public.employee_requisitions SET status = 'approved' WHERE budget_line_id = v_line AND amount = 30000;
    INSERT INTO public.requisition_wallet_credits (source_table, requisition_id, user_id, amount, status, credited_at)
    SELECT 'employee_requisitions', e.id, v_user, e.amount, 'credited', now()
      FROM public.employee_requisitions e WHERE e.budget_line_id = v_line AND e.amount = 30000 LIMIT 1;
    UPDATE public.employee_requisitions SET budget_line_id = v_line_other WHERE budget_line_id = v_line AND amount = 30000;
    r := r || jsonb_build_object('step', 14, 'pass', false, 'got', 'line changed after credit');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('step', 14, 'pass', SQLERRM LIKE 'BUDGET_LINE_LOCKED%', 'got', SQLERRM); END;

  -- the CFO returns the budget; the department may edit lines again (budget_remove_line deletes)
  UPDATE public.budget_submissions SET status = 'returned' WHERE id = v_sub;
  DECLARE v_detail text;
  BEGIN
    DELETE FROM public.budget_submission_lines WHERE id = v_line;
    r := r || jsonb_build_object('step', 15, 'pass', false, 'got', 'referenced line removed');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    r := r || jsonb_build_object('step', 15, 'pass', v_detail = 'BUDGET_LINE_IN_USE' AND SQLERRM LIKE '%cannot be removed%', 'got', SQLERRM);
  END;

  BEGIN
    INSERT INTO public.budget_submission_lines (submission_id, sort_order, description, quantity, unit_amount, status)
    VALUES (v_sub, 99, 'TEST unreferenced line', 1, 500, 'pending') RETURNING id INTO v_dir;
    DELETE FROM public.budget_submission_lines WHERE id = v_dir;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    r := r || jsonb_build_object('step', 16, 'pass', v_n = 1);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('step', 16, 'pass', false, 'got', SQLERRM); END;

  -- v_line (100,000) is fully committed (step 12). Supplements raise its allowance only once with the CFO.
  BEGIN
    INSERT INTO public.budget_supplements (submission_id, line_id, department_id, financial_year, amount, justification, status, requested_by)
    VALUES (v_sub, v_line, v_dept, '2026', 20000, 'TEST supplement, rolled-back verification', 'pending_coo', v_user);
    INSERT INTO public.director_requisitions (requester_id, title, amount, reason, budget_line_id) VALUES (v_user, 'TEST supp coo', 5000, 'rolled-back verification', v_line);
    r := r || jsonb_build_object('step', 17, 'pass', false, 'got', 'accepted');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('step', 17, 'pass', SQLERRM LIKE 'BUDGET_LINE_OVER_BUDGET%', 'got', SQLERRM); END;

  BEGIN
    INSERT INTO public.budget_supplements (submission_id, line_id, department_id, financial_year, amount, justification, status, requested_by)
    VALUES (v_sub, v_line, v_dept, '2026', 20000, 'TEST supplement, rolled-back verification', 'pending_cfo', v_user);
    INSERT INTO public.director_requisitions (requester_id, title, amount, reason, budget_line_id) VALUES (v_user, 'TEST supp cfo', 5000, 'rolled-back verification', v_line);
    UPDATE public.budget_submissions SET status = 'submitted' WHERE id = v_sub;
    SELECT max(remaining) INTO v_rem FROM public.requisition_budget_lines_available(v_dept) WHERE line_id = v_line;
    r := r || jsonb_build_object('step', 18, 'pass', v_rem = 15000, 'remaining', v_rem);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('step', 18, 'pass', false, 'got', SQLERRM); END;

  RAISE EXCEPTION 'requisition_budget_line_reference verification (rolled back): %', r;
END
$test$;
