-- 1. Deterministic activity classification (X1 maps to both operating and investing today)
CREATE OR REPLACE FUNCTION public.budget_activity_for_account(_account_code text)
 RETURNS text LANGUAGE sql STABLE SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT m.section FROM cash_flow_line_map m
      WHERE m.account_code = _account_code AND m.section IS NOT NULL
      GROUP BY m.section
      ORDER BY COUNT(*) DESC, m.section ASC
      LIMIT 1),
    (SELECT CASE
        WHEN c.section IN ('equity','non_current_liability') THEN 'financing'
        WHEN c.section = 'non_current_asset' THEN 'investing'
        ELSE 'operating' END
     FROM ledger_account_catalog c WHERE c.code = _account_code),
    'operating');
$function$;

-- 2. Which chart-of-accounts codes a department may budget against
CREATE OR REPLACE FUNCTION public.budget_is_budgetable_account(_account_code text)
 RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM ledger_account_catalog c
     WHERE c.code = _account_code
       AND (c.nature = 'expense' OR c.section = 'non_current_asset')
  );
$function$;
GRANT EXECUTE ON FUNCTION public.budget_is_budgetable_account(text) TO authenticated, service_role;

-- 3. Draft save: restrict lines to budgetable categories
CREATE OR REPLACE FUNCTION public.budget_save_draft(p_submission_id uuid, p_call_id uuid, p_department_id uuid, p_title text, p_purpose text, p_lines jsonb)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
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
END; $function$;

-- 4. Submission must respect a closed cycle
CREATE OR REPLACE FUNCTION public.budget_submit_submission(p_submission_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid(); v_sub budget_submissions; v_call budget_calls;
  v_late boolean := false; v_lines int;
BEGIN
  SELECT * INTO v_sub FROM budget_submissions WHERE id = p_submission_id;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'Submission not found'; END IF;
  IF NOT public.can_access_budget_submission(p_submission_id, v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF v_sub.status <> 'draft' THEN RAISE EXCEPTION 'Only draft budgets can be submitted'; END IF;
  SELECT COUNT(*) INTO v_lines FROM budget_submission_lines WHERE submission_id = p_submission_id;
  IF v_lines = 0 THEN RAISE EXCEPTION 'Add at least one budget line before submitting'; END IF;

  SELECT * INTO v_call FROM budget_calls WHERE id = v_sub.call_id;
  IF v_call.status <> 'open' THEN
    RAISE EXCEPTION 'Budget cycle % is %, submissions are no longer accepted', v_call.title, v_call.status;
  END IF;
  v_late := v_call.deadline IS NOT NULL AND now() > v_call.deadline;

  UPDATE budget_submissions
     SET status = 'submitted', submitted_at = now(), is_late = v_late,
         submitted_by_user_id = COALESCE(submitted_by_user_id, v_uid)
   WHERE id = p_submission_id;

  PERFORM public.budget_notify(v_call.issued_by_user_id,
      'Department budget submitted',
      'Budget '||v_sub.reference||' was submitted for review'||CASE WHEN v_late THEN ' (after the deadline)' ELSE '' END||'.',
      jsonb_build_object('submission_id', p_submission_id, 'late', v_late));

  RETURN jsonb_build_object('submission_id', p_submission_id, 'status','submitted','is_late', v_late);
END; $function$;

-- 5. Line decision: an approval can never exceed the requested amount
CREATE OR REPLACE FUNCTION public.budget_decide_line(p_line_id uuid, p_decision text, p_approved_amount numeric, p_note text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_sub uuid; v_status text; v_amount numeric; v_requested numeric;
BEGIN
  IF NOT public.is_budget_reviewer(v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF p_decision NOT IN ('approved','rejected','revision_requested','pending') THEN RAISE EXCEPTION 'Invalid decision'; END IF;
  SELECT l.submission_id, s.status, l.line_total INTO v_sub, v_status, v_requested
    FROM budget_submission_lines l JOIN budget_submissions s ON s.id = l.submission_id
   WHERE l.id = p_line_id;
  IF v_sub IS NULL THEN RAISE EXCEPTION 'Budget line not found'; END IF;
  IF v_status NOT IN ('submitted','under_review') THEN RAISE EXCEPTION 'Submission is not open for review (%).', v_status; END IF;

  IF p_decision = 'approved' THEN
    v_amount := COALESCE(p_approved_amount, v_requested);
    IF v_amount < 0 THEN RAISE EXCEPTION 'Approved amount cannot be negative'; END IF;
    IF v_amount > COALESCE(v_requested, 0) THEN
      RAISE EXCEPTION 'Approved amount cannot exceed the requested amount (%)', COALESCE(v_requested,0);
    END IF;
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
END; $function$;

-- 6. Consolidation: exclude superseded versions (a submission that has a newer child version)
CREATE OR REPLACE FUNCTION public.get_budget_consolidation(p_call_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid(); v_call budget_calls; v_from timestamptz; v_to timestamptz; v_result jsonb;
BEGIN
  IF NOT public.is_budget_reviewer(v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  SELECT * INTO v_call FROM budget_calls WHERE id = p_call_id;
  IF v_call.id IS NULL THEN RAISE EXCEPTION 'Budget cycle not found'; END IF;
  v_from := v_call.period_start::timestamptz;
  v_to := (v_call.period_end + 1)::timestamptz - interval '1 second';

  WITH live AS (
    SELECT s.* FROM budget_submissions s
     WHERE s.call_id = p_call_id
       AND NOT EXISTS (SELECT 1 FROM budget_submissions c WHERE c.parent_submission_id = s.id)
  ), approved AS (
    SELECT s.department_id, d.name AS department_name, l.account_code,
           c.label AS account_label, c.section, c.nature,
           public.budget_activity_for_account(l.account_code) AS activity,
           SUM(COALESCE(l.approved_amount,0)) AS approved_amount,
           SUM(l.line_total) AS requested_amount
    FROM live s
    JOIN budget_submission_lines l ON l.submission_id = s.id
    LEFT JOIN hr_departments d ON d.id = s.department_id
    LEFT JOIN ledger_account_catalog c ON c.code = l.account_code
    WHERE s.status = 'approved' AND l.status = 'approved'
    GROUP BY 1,2,3,4,5,6,7
  ), act AS (
    SELECT * FROM public.budget_actuals_by_account(v_from, v_to)
  )
  SELECT jsonb_build_object(
    'cycle', jsonb_build_object('id', v_call.id, 'title', v_call.title, 'financial_year', v_call.financial_year,
              'period_start', v_call.period_start, 'period_end', v_call.period_end,
              'deadline', v_call.deadline, 'status', v_call.status, 'instructions', v_call.instructions),
    'totals', jsonb_build_object(
        'requested', COALESCE((SELECT SUM(total_amount) FROM live WHERE status <> 'draft'),0),
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
END; $function$;

-- 7. Budget vs Actual: same superseded-version exclusion
CREATE OR REPLACE FUNCTION public.get_budget_vs_actual(p_call_id uuid, p_department_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
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
      AND NOT EXISTS (SELECT 1 FROM budget_submissions ch WHERE ch.parent_submission_id = s.id)
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
      AND NOT EXISTS (SELECT 1 FROM budget_submissions ch WHERE ch.parent_submission_id = s.id)
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
END; $function$;

-- 8. Budget cycles are staff-only, not readable by every signed-in user
DROP POLICY IF EXISTS budget_calls_read ON public.budget_calls;
CREATE POLICY budget_calls_read ON public.budget_calls
  FOR SELECT TO authenticated
  USING (
    public.is_budget_reviewer((SELECT auth.uid()))
    OR EXISTS (SELECT 1 FROM public.budget_user_department_ids((SELECT auth.uid())))
  );

REVOKE ALL ON public.budget_submission_documents FROM anon;

-- 9. Remove the audit test data
DELETE FROM public.budget_submission_documents
 WHERE submission_id IN (SELECT id FROM public.budget_submissions
                          WHERE call_id IN (SELECT id FROM public.budget_calls WHERE title = 'ZZ AUDIT TEST CYCLE'));
DELETE FROM public.budget_submission_lines
 WHERE submission_id IN (SELECT id FROM public.budget_submissions
                          WHERE call_id IN (SELECT id FROM public.budget_calls WHERE title = 'ZZ AUDIT TEST CYCLE'));
DELETE FROM public.budget_submission_events
 WHERE submission_id IN (SELECT id FROM public.budget_submissions
                          WHERE call_id IN (SELECT id FROM public.budget_calls WHERE title = 'ZZ AUDIT TEST CYCLE'));
DELETE FROM public.budget_submissions
 WHERE call_id IN (SELECT id FROM public.budget_calls WHERE title = 'ZZ AUDIT TEST CYCLE');
DELETE FROM public.budget_calls WHERE title = 'ZZ AUDIT TEST CYCLE';