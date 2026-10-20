-- Rolled-back verification for 20261020210000_budget_payables.sql (needs 20261020200000 first).
--
-- Run against the database AFTER both migrations. Everything happens inside one block that ends in
-- RAISE EXCEPTION, so nothing is kept. The error text IS the report: a JSON list of steps, each with
-- "pass": true/false.
--
-- Builds its own weekly call with three budgets (one on the CFO dashboard, one still with the COO, one
-- rejected) and checks:
--   1  only the on-dashboard budget's lines are payables, at the submitted amount
--   2  (B1) a 'credited' record WITHOUT a matching wallet ledger entry does NOT reduce the payable;
--        it is reported as an unproven credit. (This file never writes general_ledger, not even inside
--        a rolled-back block, so the ledger-proven path is covered by the isolated test suite.)
--   3  a linked requisition approved but not yet credited stays inside the payable (in progress)
--   4  v_payables_lines carries each outstanding line once, under category 'budget', due at week end
--   5  (B1) the lines with unproven credits carry status 'credit_unproven' on the payables list
--   6  (B1) unproven credits are not added to v_payables_payment_history
--   7  payables_category_frame lists 'budget'
--   8  get_budget_payables totals reconcile and report the unproven credits
--   9  a supplement that reached the CFO (pending_cfo) raises the line's payable; one still with the COO does not
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_user uuid; v_dept uuid; v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_call uuid; v_sub uuid; v_sub_coo uuid; v_sub_rej uuid;
  v_l1 uuid; v_l2 uuid; v_l3 uuid; v_l_coo uuid; v_l_rej uuid;
  v_req1 uuid; v_req2 uuid; v_req3 uuid;
  b record; v_n int; v_amt numeric; v_json jsonb; v_hist_before numeric;
BEGIN
  SELECT requester_id INTO v_user FROM public.staff_requisitions ORDER BY created_at DESC LIMIT 1;
  SELECT d.id INTO v_dept FROM public.hr_departments d WHERE public.budget_department_route(d.id) <> 'coo' ORDER BY d.name LIMIT 1;

  INSERT INTO public.budget_calls (title, period_type, period_start, period_end, status, issued_by_user_id)
  VALUES ('TEST weekly payables (rolled back)', '5days', v_today, v_today + 6, 'open', v_user) RETURNING id INTO v_call;
  INSERT INTO public.budget_submissions (call_id, reference, period_type, period_start, period_end, department_id, status, submitted_at)
  VALUES (v_call, 'TEST-BP-1', '5days', v_today, v_today + 6, v_dept, 'submitted', now()) RETURNING id INTO v_sub;
  INSERT INTO public.budget_submissions (call_id, reference, period_type, period_start, period_end, department_id, status, submitted_at)
  VALUES (v_call, 'TEST-BP-2', '5days', v_today, v_today + 6, v_dept, 'pending_coo', now()) RETURNING id INTO v_sub_coo;
  INSERT INTO public.budget_submissions (call_id, reference, period_type, period_start, period_end, department_id, status, submitted_at)
  VALUES (v_call, 'TEST-BP-3', '5days', v_today, v_today + 6, v_dept, 'rejected', now()) RETURNING id INTO v_sub_rej;
  INSERT INTO public.budget_submission_lines (submission_id, description, quantity, unit_amount) VALUES (v_sub, 'TEST L1', 1, 100000) RETURNING id INTO v_l1;
  INSERT INTO public.budget_submission_lines (submission_id, description, quantity, unit_amount) VALUES (v_sub, 'TEST L2', 2, 25000)  RETURNING id INTO v_l2;
  INSERT INTO public.budget_submission_lines (submission_id, description, quantity, unit_amount) VALUES (v_sub, 'TEST L3', 1, 20000)  RETURNING id INTO v_l3;
  INSERT INTO public.budget_submission_lines (submission_id, description, quantity, unit_amount) VALUES (v_sub_coo, 'TEST coo', 1, 70000) RETURNING id INTO v_l_coo;
  INSERT INTO public.budget_submission_lines (submission_id, description, quantity, unit_amount) VALUES (v_sub_rej, 'TEST rej', 1, 80000) RETURNING id INTO v_l_rej;

  -- 1
  SELECT count(*), sum(submitted_amount) INTO v_n, v_amt FROM public.v_budget_payables_lines WHERE submission_id IN (v_sub, v_sub_coo, v_sub_rej);
  r := r || jsonb_build_object('step', 1, 'pass', v_n = 3 AND v_amt = 170000, 'lines', v_n, 'submitted', v_amt);

  SELECT COALESCE(sum(amount), 0) INTO v_hist_before FROM public.v_payables_payment_history WHERE category_key = 'budget';

  -- requisitions on L1 ('credited' 60,000 and approved-not-credited 15,000) and L3 ('credited' 20,000).
  -- The credit records carry no ledger reference, so B1 must treat them as unproven.
  INSERT INTO public.director_requisitions (requester_id, title, amount, reason, budget_line_id, status)
  VALUES (v_user, 'TEST paid', 60000, 'rolled-back verification', v_l1, 'approved') RETURNING id INTO v_req1;
  INSERT INTO public.director_requisitions (requester_id, title, amount, reason, budget_line_id, status)
  VALUES (v_user, 'TEST in progress', 15000, 'rolled-back verification', v_l1, 'approved') RETURNING id INTO v_req2;
  INSERT INTO public.director_requisitions (requester_id, title, amount, reason, budget_line_id, status)
  VALUES (v_user, 'TEST paid L3', 20000, 'rolled-back verification', v_l3, 'approved') RETURNING id INTO v_req3;
  INSERT INTO public.requisition_wallet_credits (source_table, requisition_id, user_id, amount, status, credited_at)
  VALUES ('director_requisitions', v_req1, v_user, 60000, 'credited', now()),
         ('director_requisitions', v_req3, v_user, 20000, 'credited', now());

  -- 2, 3
  SELECT * INTO b FROM public.v_budget_payables_lines WHERE line_id = v_l1;
  r := r || jsonb_build_object('step', 2, 'pass', b.credited_amount = 0 AND b.unproven_credit_amount = 60000 AND b.outstanding_amount = 100000,
        'credited', b.credited_amount, 'unproven', b.unproven_credit_amount, 'outstanding', b.outstanding_amount);
  r := r || jsonb_build_object('step', 3, 'pass', b.in_progress_amount = 15000 AND b.in_progress_requisitions = 1, 'in_progress', b.in_progress_amount);

  -- 4, 5
  SELECT count(*), sum(outstanding_amount) INTO v_n, v_amt FROM public.v_payables_lines
   WHERE category_key = 'budget' AND item_id IN (v_l1, v_l2, v_l3, v_l_coo, v_l_rej);
  r := r || jsonb_build_object('step', 4, 'pass', v_n = 3 AND v_amt = 170000
        AND NOT EXISTS (SELECT 1 FROM public.v_payables_lines WHERE item_id = v_l1 AND due_date <> v_today + 6),
        'rows', v_n, 'outstanding', v_amt);
  r := r || jsonb_build_object('step', 5, 'pass',
        (SELECT count(*) FROM public.v_payables_lines WHERE item_id IN (v_l1, v_l3) AND status = 'credit_unproven') = 2
        AND (SELECT status FROM public.v_payables_lines WHERE item_id = v_l2) <> 'credit_unproven');

  -- 6
  SELECT COALESCE(sum(amount), 0) INTO v_amt FROM public.v_payables_payment_history WHERE category_key = 'budget';
  r := r || jsonb_build_object('step', 6, 'pass', v_amt = v_hist_before, 'before', v_hist_before, 'after', v_amt);

  -- 7
  r := r || jsonb_build_object('step', 7, 'pass', EXISTS (SELECT 1 FROM public.payables_category_frame() WHERE category_key = 'budget'));

  -- 8 (as a CFO-type user so payables_guard passes)
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', COALESCE((SELECT ur.user_id::text FROM public.user_roles ur WHERE ur.role::text = 'cfo' LIMIT 1), ''), true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('request.jwt.claim.sub', true))::text, true);
    v_json := public.get_budget_payables();
    r := r || jsonb_build_object('step', 8, 'pass',
      (v_json#>>'{totals,allowance}')::numeric - (v_json#>>'{totals,credited}')::numeric
        <= (v_json#>>'{totals,outstanding}')::numeric + 0.01   -- overspent lines floor at 0
      AND (v_json#>>'{totals,outstanding}')::numeric = (SELECT ROUND(SUM(outstanding_amount),2) FROM public.v_budget_payables_lines)
      AND (v_json#>>'{totals,unproven_credited}')::numeric >= 80000,
      'totals', v_json->'totals');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('step', 8, 'pass', false, 'got', SQLERRM); END;

  -- 9: supplements (L2 50,000 + 30,000 with the CFO = 80,000; L1's 10,000 still with the COO adds nothing)
  INSERT INTO public.budget_supplements (submission_id, line_id, department_id, financial_year, amount, justification, status, requested_by)
  VALUES (v_sub, v_l2, v_dept, '2026', 30000, 'TEST supplement, rolled-back verification', 'pending_cfo', v_user),
         (v_sub, v_l1, v_dept, '2026', 10000, 'TEST supplement, rolled-back verification', 'pending_coo', v_user);
  SELECT * INTO b FROM public.v_budget_payables_lines WHERE line_id = v_l2;
  r := r || jsonb_build_object('step', 9, 'pass', b.supplement_amount = 30000 AND b.allowance_amount = 80000 AND b.outstanding_amount = 80000
        AND (SELECT supplement_amount FROM public.v_budget_payables_lines WHERE line_id = v_l1) = 0
        AND (SELECT outstanding_amount FROM public.v_payables_lines WHERE item_id = v_l2) = 80000,
        'l2', to_jsonb(b));

  RAISE EXCEPTION 'budget_payables verification (rolled back): %', r;
END
$test$;
