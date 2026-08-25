ALTER TABLE public.budget_calls ADD COLUMN IF NOT EXISTS target_department_ids uuid[];

CREATE OR REPLACE FUNCTION public.budget_notify_cycle_open(_call_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_call budget_calls;
  v_sent int := 0;
  r record;
BEGIN
  SELECT * INTO v_call FROM budget_calls WHERE id = _call_id;
  IF v_call.id IS NULL OR v_call.status <> 'open' THEN RETURN 0; END IF;

  FOR r IN SELECT d.id AS department_id, d.name AS department_name
             FROM hr_departments d
            WHERE d.active
              AND (v_call.target_department_ids IS NULL
                   OR cardinality(v_call.target_department_ids) = 0
                   OR d.id = ANY (v_call.target_department_ids))
  LOOP
    INSERT INTO budget_department_notifications(call_id, department_id, title, message, metadata)
    VALUES (
      _call_id,
      r.department_id,
      'Budget cycle open: ' || v_call.title,
      'The budget cycle "' || v_call.title || '" is open for ' || r.department_name || '. '
        || CASE WHEN v_call.deadline IS NOT NULL
                THEN 'Submit the departmental budget by '
                     || to_char(v_call.deadline AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY HH24:MI') || ' (EAT).'
                ELSE 'Submit the departmental budget on the Department Budgets page.' END,
      jsonb_build_object(
        'kind', 'budget_cycle_open',
        'call_id', _call_id,
        'cycle_title', v_call.title,
        'department_id', r.department_id,
        'department_name', r.department_name,
        'deadline', v_call.deadline,
        'link', '/budgets'
      )
    )
    ON CONFLICT (call_id, department_id) DO NOTHING;

    IF FOUND THEN v_sent := v_sent + 1; END IF;
  END LOOP;

  RETURN v_sent;
END; $function$;

CREATE OR REPLACE FUNCTION public.budget_create_cycle(
  p_title text, p_financial_year text, p_period_type text, p_period_start date,
  p_period_end date, p_deadline timestamp with time zone, p_instructions text,
  p_department_ids uuid[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_id uuid; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.is_budget_reviewer(v_uid) THEN RAISE EXCEPTION 'Not authorised to create budget cycles'; END IF;
  IF p_title IS NULL OR length(trim(p_title)) < 3 THEN RAISE EXCEPTION 'Title is required'; END IF;
  INSERT INTO budget_calls(title, financial_year, period_type, period_start, period_end, deadline, instructions,
                           status, issued_by_user_id, target_department_ids)
  VALUES (trim(p_title), p_financial_year, COALESCE(p_period_type,'monthly'), p_period_start, p_period_end,
          p_deadline, p_instructions, 'open', v_uid,
          CASE WHEN p_department_ids IS NULL OR cardinality(p_department_ids) = 0 THEN NULL ELSE p_department_ids END)
  RETURNING id INTO v_id;

  PERFORM public.budget_notify_cycle_open(v_id);
  RETURN v_id;
END; $function$;