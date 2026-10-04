CREATE OR REPLACE FUNCTION public.cc_call_queue_page(
  p_subject_type cc_subject_type,
  p_state cc_row_state,
  p_sort_key text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  cycle_row_id uuid,
  subject_id uuid,
  state cc_row_state,
  attempts_made integer,
  last_attempt_at timestamptz,
  next_retry_at timestamptz,
  callback_due_at timestamptz,
  park_reason text,
  name text,
  district text,
  linked_agent_name text,
  feedback_category text,
  severity hr_ticket_severity,
  routed_to_name text,
  ticket_ref text,
  task_status text,
  fix_ticket_ref text,
  booked_by_name text,
  metric_value numeric,
  metric_date timestamptz,
  metric_text text,
  metric_label text,
  metric_format text,
  total_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cycle_id uuid;
  v_col text;
  v_dir text;
  v_nulls boolean;
  v_label text;
  v_format text;
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 500));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_order text;
  v_num_expr text;
  v_date_expr text;
  v_text_expr text;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_sql text;
BEGIN
  IF NOT cc_queue_access_allowed(p_subject_type) THEN
    RAISE EXCEPTION 'not authorized to read the % call queue', p_subject_type;
  END IF;

  SELECT c.id INTO v_cycle_id
    FROM cc_call_cycles c
   WHERE c.subject_type = p_subject_type
     AND c.closed_at IS NULL
   ORDER BY c.opened_at DESC
   LIMIT 1;

  IF v_cycle_id IS NULL THEN
    RETURN;
  END IF;

  IF p_sort_key IS NOT NULL THEN
    SELECT s.sort_column, s.direction, s.nulls_last, s.label, s.value_format
      INTO v_col, v_dir, v_nulls, v_label, v_format
      FROM cc_sort_options s
     WHERE s.subject_type = p_subject_type
       AND s.key = p_sort_key
       AND s.active
     LIMIT 1;
    IF v_col IS NULL THEN
      RAISE EXCEPTION 'sort option % does not exist for subject type %', p_sort_key, p_subject_type;
    END IF;
  ELSE
    SELECT s.sort_column, s.direction, s.nulls_last, s.label, s.value_format
      INTO v_col, v_dir, v_nulls, v_label, v_format
      FROM cc_sort_options s
     WHERE s.subject_type = p_subject_type
       AND s.active
     ORDER BY s.is_default DESC, s.sort_order
     LIMIT 1;
    IF v_col IS NULL THEN
      RAISE EXCEPTION 'no active sort option configured for subject type %', p_subject_type;
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'v_cc_call_queue' AND column_name = v_col
  ) THEN
    RAISE EXCEPTION 'sort column % is not a column of v_cc_call_queue', v_col;
  END IF;

  v_order := format('b.%I %s %s', v_col,
    CASE WHEN lower(v_dir) = 'asc' THEN 'ASC' ELSE 'DESC' END,
    CASE WHEN coalesce(v_nulls, true) THEN 'NULLS LAST' ELSE 'NULLS FIRST' END);

  v_num_expr  := CASE WHEN v_format IN ('ugx','number','days') THEN format('(b.%I)::numeric', v_col) ELSE 'NULL::numeric' END;
  v_date_expr := CASE WHEN v_format = 'date' THEN format('(b.%I)::timestamptz', v_col) ELSE 'NULL::timestamptz' END;
  v_text_expr := CASE WHEN v_format = 'text' THEN format('(b.%I)::text', v_col) ELSE 'NULL::text' END;

  v_sql := format($f$
    WITH base AS (
      SELECT q.*
        FROM v_cc_call_queue q
       WHERE q.cycle_id = %1$L
         AND q.state = %2$L
         AND (%3$L::text IS NULL
              OR q.name ILIKE '%%' || %3$L::text || '%%'
              OR q.district ILIKE '%%' || %3$L::text || '%%')
    ), counted AS (
      SELECT count(*)::bigint AS n FROM base
    )
    SELECT b.cycle_row_id, b.subject_id, b.state, b.attempts_made, b.last_attempt_at,
           b.next_retry_at, b.callback_due_at, b.park_reason, b.name, b.district,
           b.linked_agent_name, b.feedback_category, b.severity, b.routed_to_name,
           b.ticket_ref, b.task_status, b.fix_ticket_ref, b.booked_by_name,
           %4$s AS metric_value,
           %5$s AS metric_date,
           %6$s AS metric_text,
           %7$L::text AS metric_label,
           %8$L::text AS metric_format,
           counted.n AS total_count
      FROM base b CROSS JOIN counted
     ORDER BY %9$s, b.subject_id
     LIMIT %10$s OFFSET %11$s
  $f$,
    v_cycle_id,
    p_state::text,
    v_search,
    v_num_expr,
    v_date_expr,
    v_text_expr,
    v_label,
    v_format,
    v_order,
    v_limit,
    v_offset
  );

  RETURN QUERY EXECUTE v_sql;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cc_call_queue_page(cc_subject_type, cc_row_state, text, text, integer, integer) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_call_queue_page(cc_subject_type, cc_row_state, text, text, integer, integer) TO authenticated;