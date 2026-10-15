-- Supplementary budget workflow test. Everything runs in one DO block that ends by
-- raising an exception, so every row it creates is rolled back. Expect the final
-- error message to start with 'TEST_RESULT PASS'.
DO $$
DECLARE
  v_cfo uuid; v_head uuid; v_dept uuid; v_call uuid; v_sub uuid; v_line uuid; v_line2 uuid; v_pending_sub uuid; v_pending_line uuid;
  v_s1 jsonb; v_s2 jsonb; v_s3 jsonb; v_gl_before bigint; v_gl_after bigint; v_w_before text; v_w_after text;
  v_r record; v_fail text := ''; v_ok int := 0; v_err text;
  PROCEDURE_DUMMY int;
BEGIN
  SELECT ur.user_id INTO v_cfo FROM user_roles ur
   WHERE ur.role = 'cfo' AND public.is_cfo_approver(ur.user_id) AND public.is_budget_reviewer(ur.user_id) LIMIT 1;
  SELECT h.department_id, h.user_id INTO v_dept, v_head FROM budget_department_heads h
   WHERE h.active AND public.budget_department_route(h.department_id) <> 'coo' AND h.user_id <> v_cfo LIMIT 1;
  IF v_cfo IS NULL OR v_head IS NULL THEN RAISE EXCEPTION 'TEST_RESULT SKIP no cfo approver or cfo-routed head'; END IF;

  SELECT count(*) INTO v_gl_before FROM general_ledger;
  SELECT md5(string_agg(user_id::text||withdrawable_balance||float_balance||advance_balance, ',' ORDER BY user_id)) INTO v_w_before FROM wallets;

  -- Fixture: an approved budget with two approved lines, and an unapproved one.
  SELECT id INTO v_call FROM budget_calls ORDER BY created_at DESC LIMIT 1;
  INSERT INTO budget_submissions(reference, title, status, period_start, period_end, department_id, call_id, submitted_by_user_id, approved_total)
  VALUES ('TEST-SUPP-1','test','draft', current_date, current_date + 6, v_dept, v_call, v_head, 0) RETURNING id INTO v_sub;
  INSERT INTO budget_submission_lines(submission_id, description, quantity, unit_amount, status, approved_amount, account_code)
  VALUES (v_sub,'Test line A',1,100000,'approved',100000,'E1') RETURNING id INTO v_line;
  INSERT INTO budget_submission_lines(submission_id, description, quantity, unit_amount, status, approved_amount, account_code)
  VALUES (v_sub,'Test line B',1,50000,'approved',50000,'E1') RETURNING id INTO v_line2;
  UPDATE budget_submissions SET status = 'approved' WHERE id = v_sub;
  INSERT INTO budget_submissions(reference, title, status, period_start, period_end, department_id, call_id, submitted_by_user_id)
  VALUES ('TEST-SUPP-2','test','draft', current_date, current_date + 6, v_dept, v_call, v_head) RETURNING id INTO v_pending_sub;
  INSERT INTO budget_submission_lines(submission_id, description, quantity, unit_amount, status)
  VALUES (v_pending_sub,'Pending line',1,1000,'pending') RETURNING id INTO v_pending_line;

  -- As department head
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_head, 'role','authenticated')::text, true);

  BEGIN PERFORM public.budget_supplement_create(v_pending_line, 1000, 'Twenty character justification here');
    v_fail := v_fail || ' unapproved-budget-allowed;';
  EXCEPTION WHEN others THEN v_ok := v_ok + 1; END;

  BEGIN PERFORM public.budget_supplement_create(v_line, 1000, 'too short');
    v_fail := v_fail || ' short-justification-allowed;';
  EXCEPTION WHEN others THEN v_ok := v_ok + 1; END;

  v_s1 := public.budget_supplement_create(v_line, 30000, 'Fuel prices rose, extra field trips are needed');
  IF v_s1->>'status' <> 'pending_cfo' THEN v_fail := v_fail || ' wrong-initial-status;'; ELSE v_ok := v_ok + 1; END IF;

  BEGIN PERFORM public.budget_supplement_create(v_line, 5000, 'A second open request on the same line');
    v_fail := v_fail || ' duplicate-open-allowed;';
  EXCEPTION WHEN others THEN v_ok := v_ok + 1; END;

  BEGIN PERFORM public.budget_supplement_cfo_decide((v_s1->>'id')::uuid, 'approved', NULL);
    v_fail := v_fail || ' head-approved;';
  EXCEPTION WHEN others THEN v_ok := v_ok + 1; END;

  v_s2 := public.budget_supplement_create(v_line2, 20000, 'Extra stationery for the new intern intake');

  -- As CFO
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_cfo, 'role','authenticated')::text, true);
  v_s1 := public.budget_supplement_cfo_decide((v_s1->>'id')::uuid, 'approved', NULL);
  IF v_s1->>'status' <> 'approved' THEN v_fail := v_fail || ' approve-failed;'; ELSE v_ok := v_ok + 1; END IF;

  BEGIN PERFORM public.budget_supplement_cfo_decide((v_s1->>'id')::uuid, 'approved', NULL);
    v_fail := v_fail || ' double-approval-allowed;';
  EXCEPTION WHEN others THEN v_ok := v_ok + 1; END;

  BEGIN PERFORM public.budget_supplement_cfo_decide((v_s2->>'id')::uuid, 'rejected', 'no');
    v_fail := v_fail || ' reject-without-reason;';
  EXCEPTION WHEN others THEN v_ok := v_ok + 1; END;
  PERFORM public.budget_supplement_cfo_decide((v_s2->>'id')::uuid, 'rejected', 'Not justified this cycle');

  -- Revised position: line A 100000 + 30000; line B unchanged at 50000.
  FOR v_r IN SELECT * FROM public.budget_revised_position(v_call) WHERE submission_id = v_sub LOOP
    IF v_r.line_id = v_line AND (v_r.original_amount <> 100000 OR v_r.approved_supplements <> 30000 OR v_r.revised_amount <> 130000) THEN
      v_fail := v_fail || ' revised-A-wrong;'; END IF;
    IF v_r.line_id = v_line2 AND (v_r.approved_supplements <> 0 OR v_r.revised_amount <> 50000) THEN
      v_fail := v_fail || ' revised-B-wrong;'; END IF;
  END LOOP;
  IF (SELECT approved_amount FROM budget_submission_lines WHERE id = v_line) <> 100000 THEN
    v_fail := v_fail || ' original-line-changed;'; END IF;

  -- History and frozen terminal states
  IF (SELECT count(*) FROM budget_supplement_events WHERE supplement_id = (v_s1->>'id')::uuid) <> 2 THEN
    v_fail := v_fail || ' audit-count-wrong;'; END IF;
  BEGIN UPDATE budget_supplement_events SET event_type = 'x' WHERE supplement_id = (v_s1->>'id')::uuid;
    v_fail := v_fail || ' audit-editable;';
  EXCEPTION WHEN others THEN v_ok := v_ok + 1; END;

  SELECT count(*) INTO v_gl_after FROM general_ledger;
  SELECT md5(string_agg(user_id::text||withdrawable_balance||float_balance||advance_balance, ',' ORDER BY user_id)) INTO v_w_after FROM wallets;
  IF v_gl_after <> v_gl_before THEN v_fail := v_fail || ' ledger-touched;'; END IF;
  IF v_w_after IS DISTINCT FROM v_w_before THEN v_fail := v_fail || ' wallets-touched;'; END IF;
  IF EXISTS (SELECT 1 FROM budget_disbursements WHERE submission_id = v_sub) THEN v_fail := v_fail || ' disbursement-created;'; END IF;

  IF v_fail = '' THEN RAISE EXCEPTION 'TEST_RESULT PASS (% refusal/approval checks)', v_ok;
  ELSE RAISE EXCEPTION 'TEST_RESULT FAIL:%', v_fail; END IF;
END $$;
