ALTER TABLE public.cc_call_cycles
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS description text;

CREATE OR REPLACE FUNCTION public.cc_open_cycle(
  p_subject_type cc_subject_type,
  p_population_code text,
  p_limit integer DEFAULT NULL::integer,
  p_title text DEFAULT NULL::text,
  p_description text DEFAULT NULL::text
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pop public.cc_cycle_populations;
  v_cycle_id uuid;
  v_cycle_no integer;
  v_sql text;
  v_limit integer;
  v_title text;
  v_description text;
BEGIN
  IF NOT (public.has_role(auth.uid(),'operations')
       OR public.has_role(auth.uid(),'hr')
       OR public.has_role(auth.uid(),'super_admin')) THEN
    RAISE EXCEPTION 'Not authorised to open a calling cycle.';
  END IF;

  v_title := btrim(coalesce(p_title, ''));
  v_description := nullif(btrim(coalesce(p_description, '')), '');

  IF length(v_title) < 3 THEN
    RAISE EXCEPTION 'A cycle title of at least 3 characters is required.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.cc_call_cycles
    WHERE subject_type = p_subject_type AND closed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'An open % cycle already exists. Close it first.', p_subject_type;
  END IF;

  SELECT * INTO v_pop
  FROM public.cc_cycle_populations
  WHERE subject_type = p_subject_type AND code = p_population_code;

  IF v_pop.id IS NULL THEN
    RAISE EXCEPTION 'Unknown population % for subject type %.', p_population_code, p_subject_type;
  END IF;

  IF NOT v_pop.active THEN
    RAISE EXCEPTION 'Population % is inactive.', p_population_code;
  END IF;

  v_limit := p_limit;
  IF v_pop.max_rows IS NOT NULL AND (v_limit IS NULL OR v_limit > v_pop.max_rows) THEN
    v_limit := v_pop.max_rows;
  END IF;

  SELECT coalesce(max(cycle_no), 0) + 1 INTO v_cycle_no
  FROM public.cc_call_cycles
  WHERE subject_type = p_subject_type;

  INSERT INTO public.cc_call_cycles
    (subject_type, cycle_no, opened_by, retry_after_days, attempt_cap, title, description)
  VALUES (p_subject_type, v_cycle_no, auth.uid(), 3, 2, v_title, v_description)
  RETURNING id INTO v_cycle_id;

  v_sql := format(
    'INSERT INTO public.cc_cycle_rows (cycle_id, subject_type, subject_id, state, priority_value)
     SELECT %L::uuid, %L::cc_subject_type, s.subject_id, ''to_call''::cc_row_state, s.priority_value
     FROM (
       SELECT DISTINCT ON (v.%I) v.%I AS subject_id, %s AS priority_value
       FROM public.%I v
       WHERE v.%I IS NOT NULL %s
       ORDER BY v.%I, %s DESC NULLS LAST, v::text
     ) s
     ORDER BY s.priority_value DESC NULLS LAST
     %s',
    v_cycle_id,
    p_subject_type,
    v_pop.subject_id_column,
    v_pop.subject_id_column,
    CASE WHEN v_pop.priority_column IS NULL
         THEN 'NULL::numeric'
         ELSE format('v.%I::numeric', v_pop.priority_column) END,
    v_pop.source_view,
    v_pop.subject_id_column,
    CASE WHEN v_pop.filter_sql IS NULL OR btrim(v_pop.filter_sql) = ''
         THEN ''
         ELSE 'AND (' || v_pop.filter_sql || ')' END,
    v_pop.subject_id_column,
    CASE WHEN v_pop.priority_column IS NULL
         THEN 'NULL::numeric'
         ELSE format('v.%I::numeric', v_pop.priority_column) END,
    CASE WHEN v_limit IS NULL THEN '' ELSE format('LIMIT %s', v_limit::integer) END
  );

  EXECUTE v_sql;

  RETURN v_cycle_id;
END;
$function$;

DROP VIEW IF EXISTS public.v_cc_cycle_progress;
CREATE VIEW public.v_cc_cycle_progress AS
 SELECT c.id AS cycle_id,
    c.subject_type,
    c.cycle_no,
    c.title,
    c.description,
    c.opened_at,
    count(r.id) AS total_rows,
    count(*) FILTER (WHERE r.state = 'to_call'::cc_row_state) AS to_call_rows,
    count(*) FILTER (WHERE r.state = 'engaged'::cc_row_state) AS engaged_rows,
    count(*) FILTER (WHERE r.state = 'unreachable'::cc_row_state) AS unreachable_rows,
    count(*) FILTER (WHERE r.state = 'callback'::cc_row_state) AS callback_rows,
    count(*) FILTER (WHERE r.state = 'parked'::cc_row_state) AS parked_rows,
    count(*) FILTER (WHERE r.state = 'closed'::cc_row_state) AS closed_rows,
    count(*) FILTER (WHERE r.attempts_made > 0) AS attempted_rows,
    round(count(*) FILTER (WHERE r.attempts_made > 0)::numeric / NULLIF(count(r.id), 0)::numeric * 100::numeric, 1) AS coverage_pct,
    round(count(*) FILTER (WHERE r.state = 'engaged'::cc_row_state)::numeric / NULLIF(count(*) FILTER (WHERE r.attempts_made > 0), 0)::numeric * 100::numeric, 1) AS reach_pct
   FROM cc_call_cycles c
     LEFT JOIN cc_cycle_rows r ON r.cycle_id = c.id
  WHERE c.closed_at IS NULL
  GROUP BY c.id, c.subject_type, c.cycle_no, c.title, c.description, c.opened_at;

ALTER VIEW public.v_cc_cycle_progress SET (security_invoker = true);