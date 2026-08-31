-- 1. value_format on cc_sort_options
ALTER TABLE public.cc_sort_options
  ADD COLUMN IF NOT EXISTS value_format text NOT NULL DEFAULT 'number';

ALTER TABLE public.cc_sort_options
  DROP CONSTRAINT IF EXISTS cc_sort_options_value_format_check;
ALTER TABLE public.cc_sort_options
  ADD CONSTRAINT cc_sort_options_value_format_check
  CHECK (value_format IN ('ugx','number','days','date','text'));

UPDATE public.cc_sort_options SET value_format = v.fmt
FROM (VALUES
  ('tenant','arrears_amount','ugx'),
  ('tenant','outstanding','ugx'),
  ('tenant','daily_repayment','ugx'),
  ('tenant','schedule_delta_days','days'),
  ('tenant','days_since_funded','days'),
  ('tenant','last_payment_at','date'),
  ('tenant','name','text'),
  ('landlord','plan_rent_total','ugx'),
  ('landlord','houses_monthly_rent','ugx'),
  ('landlord','monthly_rent','ugx'),
  ('landlord','houses','number'),
  ('landlord','empty_houses','number'),
  ('landlord','plans','number'),
  ('landlord','last_paid_at','date'),
  ('landlord','name','text'),
  ('agent','advance_outstanding','ugx'),
  ('agent','advance_arrears','ugx'),
  ('agent','own_cash_outstanding','ugx'),
  ('agent','active_tenants','number'),
  ('agent','active_capability_count','number'),
  ('agent','last_active_at','date'),
  ('agent','name','text')
) AS v(st, k, fmt)
WHERE cc_sort_options.subject_type::text = v.st
  AND cc_sort_options.key = v.k;

-- 2. cc_abandon_cycle
ALTER TABLE public.cc_call_cycles
  ADD COLUMN IF NOT EXISTS abandoned_reason text NULL;

CREATE OR REPLACE FUNCTION public.cc_abandon_cycle(p_cycle_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_closed timestamptz;
BEGIN
  IF NOT (
    has_role(auth.uid(), 'operations'::app_role)
    OR has_role(auth.uid(), 'hr'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized to abandon a call cycle';
  END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'a reason is required to abandon a cycle';
  END IF;

  SELECT closed_at INTO v_closed FROM cc_call_cycles WHERE id = p_cycle_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cycle % not found', p_cycle_id;
  END IF;
  IF v_closed IS NOT NULL THEN
    RAISE EXCEPTION 'cycle % is already closed', p_cycle_id;
  END IF;

  UPDATE cc_cycle_rows
     SET state = 'closed'::cc_row_state,
         closed_at = now()
   WHERE cycle_id = p_cycle_id
     AND state IN ('to_call'::cc_row_state,'unreachable'::cc_row_state,'callback'::cc_row_state);

  UPDATE cc_call_cycles
     SET closed_at = now(),
         abandoned_reason = btrim(p_reason)
   WHERE id = p_cycle_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cc_abandon_cycle(uuid, text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_abandon_cycle(uuid, text) TO authenticated;

-- shared permission helper for queue reads
CREATE OR REPLACE FUNCTION public.cc_queue_access_allowed(p_subject_type cc_subject_type)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT has_role(auth.uid(), 'operations'::app_role)
      OR has_role(auth.uid(), 'hr'::app_role)
      OR has_role(auth.uid(), 'ceo'::app_role)
      OR has_role(auth.uid(), 'coo'::app_role)
      OR has_role(auth.uid(), 'super_admin'::app_role)
      OR (p_subject_type = 'tenant'::cc_subject_type   AND has_role(auth.uid(), 'tenant_ops'::app_role))
      OR (p_subject_type = 'landlord'::cc_subject_type AND has_role(auth.uid(), 'landlord_ops'::app_role))
      OR (p_subject_type = 'agent'::cc_subject_type    AND has_role(auth.uid(), 'agent_ops'::app_role));
$$;

REVOKE EXECUTE ON FUNCTION public.cc_queue_access_allowed(cc_subject_type) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_queue_access_allowed(cc_subject_type) TO authenticated;

-- 3. cc_call_queue_page
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
  v_nulls text;
  v_label text;
  v_format text;
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 500));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
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

  v_sql := format($f$
    WITH base AS (
      SELECT q.*
        FROM v_cc_call_queue q
       WHERE q.cycle_id = %1$L
         AND q.state = %2$L
         AND (%3$L::text IS NULL
              OR q.name ILIKE '%%' || %3$L || '%%'
              OR q.district ILIKE '%%' || %3$L || '%%')
    ), counted AS (
      SELECT count(*)::bigint AS n FROM base
    )
    SELECT b.cycle_row_id, b.subject_id, b.state, b.attempts_made, b.last_attempt_at,
           b.next_retry_at, b.callback_due_at, b.park_reason, b.name, b.district,
           b.linked_agent_name, b.feedback_category, b.severity, b.routed_to_name,
           b.ticket_ref, b.task_status, b.fix_ticket_ref, b.booked_by_name,
           CASE WHEN %6$L IN ('ugx','number','days') THEN (b.%4$I)::numeric ELSE NULL END AS metric_value,
           CASE WHEN %6$L = 'date' THEN (b.%4$I)::timestamptz ELSE NULL END AS metric_date,
           CASE WHEN %6$L = 'text' THEN (b.%4$I)::text ELSE NULL END AS metric_text,
           %7$L::text AS metric_label,
           %6$L::text AS metric_format,
           counted.n AS total_count
      FROM base b CROSS JOIN counted
     ORDER BY b.%4$I %5$s, b.subject_id
     LIMIT %8$s OFFSET %9$s
  $f$,
    v_cycle_id,
    p_state::text,
    nullif(btrim(coalesce(p_search,'')), ''),
    v_col,
    (CASE WHEN lower(v_dir) = 'asc' THEN 'ASC' ELSE 'DESC' END)
      || (CASE WHEN v_nulls THEN ' NULLS LAST' ELSE ' NULLS FIRST' END),
    v_format,
    v_label,
    v_limit,
    v_offset
  );

  RETURN QUERY EXECUTE v_sql;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cc_call_queue_page(cc_subject_type, cc_row_state, text, text, integer, integer) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_call_queue_page(cc_subject_type, cc_row_state, text, text, integer, integer) TO authenticated;

-- 4. cc_state_counts
CREATE OR REPLACE FUNCTION public.cc_state_counts(p_subject_type cc_subject_type)
RETURNS TABLE (state cc_row_state, row_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cycle_id uuid;
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

  RETURN QUERY
  SELECT s.s AS state, coalesce(count(r.id), 0)::bigint AS row_count
    FROM unnest(enum_range(NULL::cc_row_state)) AS s(s)
    LEFT JOIN cc_cycle_rows r
           ON r.cycle_id = v_cycle_id AND r.state = s.s
   GROUP BY s.s
   ORDER BY s.s;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cc_state_counts(cc_subject_type) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_state_counts(cc_subject_type) TO authenticated;