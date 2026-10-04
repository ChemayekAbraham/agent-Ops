-- ============ Stage 2: Budget workflow RPCs (SECURITY DEFINER, RLS-equivalent checks inside) ============

-- Notification helper (uses existing notifications table)
CREATE OR REPLACE FUNCTION public.budget_notify(_user_id uuid, _title text, _message text, _meta jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF _user_id IS NULL THEN RETURN; END IF;
  INSERT INTO notifications(user_id, title, message, type, metadata)
  VALUES (_user_id, _title, _message, 'budget', COALESCE(_meta,'{}'::jsonb));
EXCEPTION WHEN OTHERS THEN RETURN;
END; $$;

-- Cycle creation (reviewers only)
CREATE OR REPLACE FUNCTION public.budget_create_cycle(
  p_title text, p_financial_year text, p_period_type text,
  p_period_start date, p_period_end date, p_deadline timestamptz, p_instructions text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.is_budget_reviewer(v_uid) THEN RAISE EXCEPTION 'Not authorised to create budget cycles'; END IF;
  IF p_title IS NULL OR length(trim(p_title)) < 3 THEN RAISE EXCEPTION 'Title is required'; END IF;
  INSERT INTO budget_calls(title, financial_year, period_type, period_start, period_end, deadline, instructions,
                           status, issued_by_user_id)
  VALUES (trim(p_title), p_financial_year, COALESCE(p_period_type,'monthly'), p_period_start, p_period_end,
          p_deadline, p_instructions, 'open', v_uid)
  RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.budget_set_cycle_status(p_call_id uuid, p_status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_budget_reviewer(auth.uid()) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF p_status NOT IN ('open','closed','cancelled') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  UPDATE budget_calls SET status = p_status, updated_at = now() WHERE id = p_call_id;
END; $$;

-- Draft save (department users only, own department, editable states only)
CREATE OR REPLACE FUNCTION public.budget_save_draft(
  p_submission_id uuid, p_call_id uuid, p_department_id uuid,
  p_title text, p_purpose text, p_lines jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
    SELECT * INTO v_call FROM budget_calls WHERE id = p_call_id;
    IF v_call.id IS NULL THEN RAISE EXCEPTION 'Budget cycle not found'; END IF;
    IF v_call.status <> 'open' THEN RAISE EXCEPTION 'Budget cycle is not open'; END IF;
    IF NOT (public.is_budget_reviewer(v_uid)
            OR p_department_id IN (SELECT public.budget_user_department_ids(v_uid))) THEN
      RAISE EXCEPTION 'You can only budget for your own department';
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
      INSERT INTO budget_submission_lines(submission_id, sort_order, description, category, account_code,
        quantity, unit_amount, period_month, justification, document_path, status)
      VALUES (v_id, v_idx, v_line->>'description',
              NULLIF(v_line->>'category',''), v_line->>'account_code',
              GREATEST(COALESCE((v_line->>'quantity')::numeric, 1), 0.0001),
              GREATEST(COALESCE((v_line->>'unit_amount')::numeric, 0), 0),
              NULLIF(v_line->>'period_month','')::date,
              NULLIF(v_line->>'justification',''),
              NULLIF(v_line->>'document_path',''), 'pending');
    END LOOP;
  END IF;

  SELECT COALESCE(SUM(line_total),0) INTO v_total FROM budget_submission_lines WHERE submission_id = v_id;
  UPDATE budget_submissions SET total_amount = v_total WHERE id = v_id;
  RETURN v_id;
END; $$;

-- Submit (flags late, never blocks)
CREATE OR REPLACE FUNCTION public.budget_submit_submission(p_submission_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_sub budget_submissions; v_deadline timestamptz; v_late boolean := false; v_lines int;
BEGIN
  SELECT * INTO v_sub FROM budget_submissions WHERE id = p_submission_id;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF NOT public.can_access_budget_submission(p_submission_id, v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF v_sub.status <> 'draft' THEN RAISE EXCEPTION 'Only draft budgets can be submitted'; END IF;
  SELECT COUNT(*) INTO v_lines FROM budget_submission_lines WHERE submission_id = p_submission_id;
  IF v_lines = 0 THEN RAISE EXCEPTION 'Add at least one budget line before submitting'; END IF;

  SELECT deadline INTO v_deadline FROM budget_calls WHERE id = v_sub.call_id;
  v_late := v_deadline IS NOT NULL AND now() > v_deadline;

  UPDATE budget_submissions
     SET status = 'submitted', submitted_at = now(), is_late = v_late, submitted_by_user_id = COALESCE(submitted_by_user_id, v_uid)
   WHERE id = p_submission_id;

  PERFORM public.budget_notify(bc.issued_by_user_id,
      'Department budget submitted',
      'Budget '||v_sub.reference||' was submitted for review'||CASE WHEN v_late THEN ' (after the deadline)' ELSE '' END||'.',
      jsonb_build_object('submission_id', p_submission_id, 'late', v_late))
  FROM budget_calls bc WHERE bc.id = v_sub.call_id;

  RETURN jsonb_build_object('submission_id', p_submission_id, 'status','submitted','is_late', v_late);
END; $$;

-- Reviewer marks under review
CREATE OR REPLACE FUNCTION public.budget_start_review(p_submission_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_budget_reviewer(auth.uid()) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  UPDATE budget_submissions SET status = 'under_review', reviewed_by = auth.uid()
   WHERE id = p_submission_id AND status IN ('submitted','under_review');
END; $$;

-- Request revision: original preserved, new draft version created
CREATE OR REPLACE FUNCTION public.budget_request_revision(p_submission_id uuid, p_comment text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_sub budget_submissions; v_new uuid;
BEGIN
  IF NOT public.is_budget_reviewer(v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF p_comment IS NULL OR length(trim(p_comment)) < 10 THEN
    RAISE EXCEPTION 'Provide a revision reason of at least 10 characters';
  END IF;
  SELECT * INTO v_sub FROM budget_submissions WHERE id = p_submission_id;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF v_sub.status NOT IN ('submitted','under_review') THEN RAISE EXCEPTION 'Cannot request revision in status %', v_sub.status; END IF;

  UPDATE budget_submissions
     SET status = 'revision_requested', cfo_comment = trim(p_comment), reviewed_at = now(), reviewed_by = v_uid
   WHERE id = p_submission_id;

  INSERT INTO budget_submissions(call_id, department_id, reference, title, purpose, status, period_type,
      period_start, period_end, submitted_by_user_id, submitted_by_position_id, total_amount,
      version, parent_submission_id)
  VALUES (v_sub.call_id, v_sub.department_id,
      v_sub.reference||'-R'||(v_sub.version + 1), v_sub.title, v_sub.purpose, 'draft', v_sub.period_type,
      v_sub.period_start, v_sub.period_end, v_sub.submitted_by_user_id, v_sub.submitted_by_position_id, 0,
      v_sub.version + 1, p_submission_id)
  RETURNING id INTO v_new;

  INSERT INTO budget_submission_lines(submission_id, sort_order, description, category, account_code,
      quantity, unit_amount, period_month, justification, document_path, status)
  SELECT v_new, sort_order, description, category, account_code, quantity, unit_amount,
         period_month, justification, document_path, 'pending'
  FROM budget_submission_lines WHERE submission_id = p_submission_id ORDER BY sort_order;

  UPDATE budget_submissions
     SET total_amount = (SELECT COALESCE(SUM(line_total),0) FROM budget_submission_lines WHERE submission_id = v_new)
   WHERE id = v_new;

  PERFORM public.budget_notify(v_sub.submitted_by_user_id, 'Budget revision requested',
      'Budget '||v_sub.reference||' needs revision: '||trim(p_comment),
      jsonb_build_object('submission_id', p_submission_id, 'new_submission_id', v_new));

  RETURN v_new;
END; $$;

-- Line-level decision with editable approved amount
CREATE OR REPLACE FUNCTION public.budget_decide_line(
  p_line_id uuid, p_decision text, p_approved_amount numeric, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_sub uuid; v_status text; v_amount numeric;
BEGIN
  IF NOT public.is_budget_reviewer(v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF p_decision NOT IN ('approved','rejected','revision_requested','pending') THEN RAISE EXCEPTION 'Invalid decision'; END IF;
  SELECT l.submission_id, s.status INTO v_sub, v_status
    FROM budget_submission_lines l JOIN budget_submissions s ON s.id = l.submission_id
   WHERE l.id = p_line_id;
  IF v_sub IS NULL THEN RAISE EXCEPTION 'Budget line not found'; END IF;
  IF v_status NOT IN ('submitted','under_review') THEN RAISE EXCEPTION 'Submission is not open for review (%).', v_status; END IF;

  IF p_decision = 'approved' THEN
    SELECT COALESCE(p_approved_amount, line_total) INTO v_amount FROM budget_submission_lines WHERE id = p_line_id;
    IF v_amount < 0 THEN RAISE EXCEPTION 'Approved amount cannot be negative'; END IF;
  ELSE
    v_amount := 0;
  END IF;

  UPDATE budget_submission_lines
     SET status = p_decision, approved_amount = v_amount, decision_note = NULLIF(trim(COALESCE(p_note,'')),''),
         decided_by = v_uid, decided_at = now()
   WHERE id = p_line_id;

  UPDATE budget_submissions
     SET approved_total = (SELECT COALESCE(SUM(approved_amount),0) FROM budget_submission_lines
                            WHERE submission_id = v_sub AND status = 'approved'),
         status = 'under_review', reviewed_by = v_uid
   WHERE id = v_sub;

  RETURN jsonb_build_object('line_id', p_line_id, 'status', p_decision, 'approved_amount', v_amount);
END; $$;

-- Finalize submission
CREATE OR REPLACE FUNCTION public.budget_finalize_submission(p_submission_id uuid, p_decision text, p_comment text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_sub budget_submissions; v_approved numeric; v_pending int;
BEGIN
  IF NOT public.is_budget_reviewer(v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF p_decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'Invalid decision'; END IF;
  SELECT * INTO v_sub FROM budget_submissions WHERE id = p_submission_id;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF v_sub.status NOT IN ('submitted','under_review') THEN RAISE EXCEPTION 'Cannot finalise in status %', v_sub.status; END IF;

  IF p_decision = 'approved' THEN
    SELECT COUNT(*) INTO v_pending FROM budget_submission_lines
      WHERE submission_id = p_submission_id AND status = 'pending';
    IF v_pending > 0 THEN RAISE EXCEPTION 'Decide all % remaining line item(s) first', v_pending; END IF;
  ELSE
    IF p_comment IS NULL OR length(trim(p_comment)) < 10 THEN
      RAISE EXCEPTION 'Provide a rejection reason of at least 10 characters';
    END IF;
    UPDATE budget_submission_lines SET status = 'rejected', approved_amount = 0, decided_by = v_uid, decided_at = now()
      WHERE submission_id = p_submission_id AND status <> 'rejected';
  END IF;

  SELECT COALESCE(SUM(approved_amount),0) INTO v_approved FROM budget_submission_lines
    WHERE submission_id = p_submission_id AND status = 'approved';

  UPDATE budget_submissions
     SET status = p_decision, approved_total = v_approved, reviewed_at = now(), reviewed_by = v_uid,
         cfo_comment = COALESCE(NULLIF(trim(COALESCE(p_comment,'')),''), cfo_comment)
   WHERE id = p_submission_id;

  PERFORM public.budget_notify(v_sub.submitted_by_user_id,
     CASE WHEN p_decision = 'approved' THEN 'Budget approved' ELSE 'Budget rejected' END,
     'Budget '||v_sub.reference||' was '||p_decision||'.'||COALESCE(' '||NULLIF(trim(COALESCE(p_comment,'')),''),''),
     jsonb_build_object('submission_id', p_submission_id, 'approved_total', v_approved));

  RETURN jsonb_build_object('submission_id', p_submission_id, 'status', p_decision, 'approved_total', v_approved);
END; $$;

-- Actuals from the existing General Ledger (never hard-coded)
CREATE OR REPLACE FUNCTION public.budget_actuals_by_account(p_from timestamptz, p_to timestamptz)
RETURNS TABLE(account_code text, actual numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH resolved AS (
    SELECT COALESCE(mb.account_code, mw.account_code,
             CASE WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket = 'float'   THEN 'A2'
                  WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket = 'advance' THEN 'A4'
                  WHEN gl.ledger_scope = 'wallet'                                  THEN 'L1'
                  ELSE 'A9' END) AS account_code,
           COALESCE(mb.debit_when, mw.debit_when,
             CASE WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket IN ('float','advance') THEN 'cash_in'
                  WHEN gl.ledger_scope = 'wallet'                                             THEN 'cash_out'
                  ELSE 'cash_in' END) AS debit_when,
           gl.direction, gl.amount
    FROM general_ledger gl
    LEFT JOIN ledger_account_map mb
           ON mb.ledger_scope = gl.ledger_scope AND mb.category = gl.category
          AND mb.wallet_bucket IS NOT NULL AND mb.wallet_bucket = gl.wallet_bucket
    LEFT JOIN ledger_account_map mw
           ON mw.ledger_scope = gl.ledger_scope AND mw.category = gl.category AND mw.wallet_bucket IS NULL
    WHERE gl.classification IN ('production','legacy_real')
      AND gl.transaction_date >= p_from AND gl.transaction_date <= p_to
  )
  SELECT r.account_code,
         SUM(CASE WHEN r.direction = r.debit_when THEN r.amount ELSE -r.amount END)::numeric
  FROM resolved r
  GROUP BY r.account_code;
$$;

-- Consolidated company budget + Budget vs Actual
CREATE OR REPLACE FUNCTION public.get_budget_consolidation(p_call_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_call budget_calls; v_from timestamptz; v_to timestamptz; v_result jsonb;
BEGIN
  IF NOT public.is_budget_reviewer(v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  SELECT * INTO v_call FROM budget_calls WHERE id = p_call_id;
  IF v_call.id IS NULL THEN RAISE EXCEPTION 'Budget cycle not found'; END IF;
  v_from := v_call.period_start::timestamptz;
  v_to := (v_call.period_end + 1)::timestamptz - interval '1 second';

  WITH approved AS (
    SELECT s.department_id, d.name AS department_name, l.account_code,
           c.label AS account_label, c.section, c.nature,
           public.budget_activity_for_account(l.account_code) AS activity,
           SUM(COALESCE(l.approved_amount,0)) AS approved_amount,
           SUM(l.line_total) AS requested_amount
    FROM budget_submissions s
    JOIN budget_submission_lines l ON l.submission_id = s.id
    LEFT JOIN hr_departments d ON d.id = s.department_id
    LEFT JOIN ledger_account_catalog c ON c.code = l.account_code
    WHERE s.call_id = p_call_id AND s.status = 'approved' AND l.status = 'approved'
    GROUP BY 1,2,3,4,5,6,7
  ), act AS (
    SELECT * FROM public.budget_actuals_by_account(v_from, v_to)
  )
  SELECT jsonb_build_object(
    'cycle', jsonb_build_object('id', v_call.id, 'title', v_call.title, 'financial_year', v_call.financial_year,
              'period_start', v_call.period_start, 'period_end', v_call.period_end,
              'deadline', v_call.deadline, 'status', v_call.status, 'instructions', v_call.instructions),
    'totals', jsonb_build_object(
        'requested', COALESCE((SELECT SUM(total_amount) FROM budget_submissions WHERE call_id = p_call_id AND status <> 'draft'),0),
        'approved', COALESCE((SELECT SUM(approved_amount) FROM approved),0)),
    'by_activity', COALESCE((
        SELECT jsonb_agg(x ORDER BY x->>'activity')
        FROM (SELECT jsonb_build_object('activity', a.activity,
                     'approved', SUM(a.approved_amount), 'requested', SUM(a.requested_amount)) AS x
              FROM approved a GROUP BY a.activity) q), '[]'::jsonb),
    'by_department', COALESCE((
        SELECT jsonb_agg(x ORDER BY x->>'department_name')
        FROM (SELECT jsonb_build_object('department_id', a.department_id, 'department_name',
                     COALESCE(a.department_name,'Unassigned'),
                     'approved', SUM(a.approved_amount), 'requested', SUM(a.requested_amount)) AS x
              FROM approved a GROUP BY a.department_id, a.department_name) q), '[]'::jsonb),
    'by_account', COALESCE((
        SELECT jsonb_agg(x ORDER BY x->>'account_code')
        FROM (SELECT jsonb_build_object('account_code', a.account_code, 'account_label', a.account_label,
                     'activity', a.activity, 'section', a.section,
                     'approved', SUM(a.approved_amount), 'requested', SUM(a.requested_amount),
                     'actual', COALESCE(MAX(ac.actual),0),
                     'variance', SUM(a.approved_amount) - COALESCE(MAX(ac.actual),0),
                     'utilization_pct', CASE WHEN SUM(a.approved_amount) > 0
                        THEN ROUND(COALESCE(MAX(ac.actual),0) / SUM(a.approved_amount) * 100, 2) ELSE NULL END) AS x
              FROM approved a LEFT JOIN act ac ON ac.account_code = a.account_code
              GROUP BY a.account_code, a.account_label, a.activity, a.section) q), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END; $$;

-- Budget vs Actual (department + company), live from the General Ledger
CREATE OR REPLACE FUNCTION public.get_budget_vs_actual(p_call_id uuid, p_department_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_call budget_calls; v_from timestamptz; v_to timestamptz;
  v_reviewer boolean := public.is_budget_reviewer(auth.uid()); v_result jsonb;
BEGIN
  SELECT * INTO v_call FROM budget_calls WHERE id = p_call_id;
  IF v_call.id IS NULL THEN RAISE EXCEPTION 'Budget cycle not found'; END IF;
  IF NOT v_reviewer THEN
    IF p_department_id IS NULL OR p_department_id NOT IN (SELECT public.budget_user_department_ids(v_uid)) THEN
      RAISE EXCEPTION 'Not authorised for this department';
    END IF;
  END IF;
  v_from := v_call.period_start::timestamptz;
  v_to := (v_call.period_end + 1)::timestamptz - interval '1 second';

  WITH lines AS (
    SELECT s.department_id, d.name AS department_name, l.account_code, c.label AS account_label,
           public.budget_activity_for_account(l.account_code) AS activity,
           SUM(COALESCE(l.approved_amount,0)) AS approved_amount,
           SUM(l.line_total) AS requested_amount
    FROM budget_submissions s
    JOIN budget_submission_lines l ON l.submission_id = s.id
    LEFT JOIN hr_departments d ON d.id = s.department_id
    LEFT JOIN ledger_account_catalog c ON c.code = l.account_code
    WHERE s.call_id = p_call_id AND s.status = 'approved' AND l.status = 'approved'
      AND (p_department_id IS NULL OR s.department_id = p_department_id)
    GROUP BY 1,2,3,4,5
  ), act AS (SELECT * FROM public.budget_actuals_by_account(v_from, v_to)),
  prev AS (
    SELECT l.account_code, SUM(COALESCE(l.approved_amount,0)) AS prev_approved
    FROM budget_submissions s
    JOIN budget_submission_lines l ON l.submission_id = s.id
    JOIN budget_calls bc ON bc.id = s.call_id
    WHERE s.status = 'approved' AND l.status = 'approved'
      AND bc.period_end < v_call.period_start
      AND (p_department_id IS NULL OR s.department_id = p_department_id)
    GROUP BY l.account_code
  )
  SELECT jsonb_build_object(
    'cycle', jsonb_build_object('id', v_call.id, 'title', v_call.title, 'financial_year', v_call.financial_year,
             'period_start', v_call.period_start, 'period_end', v_call.period_end),
    'rows', COALESCE((SELECT jsonb_agg(x ORDER BY x->>'department_name', x->>'account_code') FROM (
        SELECT jsonb_build_object(
          'department_id', li.department_id, 'department_name', COALESCE(li.department_name,'Unassigned'),
          'account_code', li.account_code, 'account_label', li.account_label, 'activity', li.activity,
          'requested', li.requested_amount, 'approved', li.approved_amount,
          'previous_budget', COALESCE(p.prev_approved,0),
          'actual', COALESCE(a.actual,0),
          'variance', li.approved_amount - COALESCE(a.actual,0),
          'utilization_pct', CASE WHEN li.approved_amount > 0
              THEN ROUND(COALESCE(a.actual,0)/li.approved_amount*100,2) ELSE NULL END) AS x
        FROM lines li
        LEFT JOIN act a ON a.account_code = li.account_code
        LEFT JOIN prev p ON p.account_code = li.account_code) q), '[]'::jsonb),
    'totals', (SELECT jsonb_build_object(
        'approved', COALESCE(SUM(li.approved_amount),0),
        'requested', COALESCE(SUM(li.requested_amount),0),
        'actual', COALESCE(SUM(COALESCE(a.actual,0)),0))
      FROM lines li LEFT JOIN act a ON a.account_code = li.account_code)
  ) INTO v_result;

  RETURN v_result;
END; $$;

REVOKE ALL ON FUNCTION public.budget_create_cycle(text,text,text,date,date,timestamptz,text) FROM anon;
REVOKE ALL ON FUNCTION public.budget_set_cycle_status(uuid,text) FROM anon;
REVOKE ALL ON FUNCTION public.budget_save_draft(uuid,uuid,uuid,text,text,jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.budget_submit_submission(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.budget_start_review(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.budget_request_revision(uuid,text) FROM anon;
REVOKE ALL ON FUNCTION public.budget_decide_line(uuid,text,numeric,text) FROM anon;
REVOKE ALL ON FUNCTION public.budget_finalize_submission(uuid,text,text) FROM anon;
REVOKE ALL ON FUNCTION public.budget_actuals_by_account(timestamptz,timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.get_budget_consolidation(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_budget_vs_actual(uuid,uuid) FROM anon;
REVOKE ALL ON FUNCTION public.budget_notify(uuid,text,text,jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.budget_create_cycle(text,text,text,date,date,timestamptz,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.budget_set_cycle_status(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.budget_save_draft(uuid,uuid,uuid,text,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.budget_submit_submission(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.budget_start_review(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.budget_request_revision(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.budget_decide_line(uuid,text,numeric,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.budget_finalize_submission(uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_budget_consolidation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_budget_vs_actual(uuid,uuid) TO authenticated;