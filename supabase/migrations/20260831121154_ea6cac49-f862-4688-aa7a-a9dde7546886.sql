-- WELILE-CC-ROSTER5: cycle roster built from ops base views

CREATE TABLE public.cc_cycle_populations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type cc_subject_type NOT NULL,
  code text NOT NULL,
  label text NOT NULL,
  source_view text NOT NULL,
  subject_id_column text NOT NULL,
  priority_column text NULL,
  filter_sql text NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, code)
);

GRANT SELECT ON public.cc_cycle_populations TO authenticated;
GRANT ALL ON public.cc_cycle_populations TO service_role;

ALTER TABLE public.cc_cycle_populations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cc_cycle_populations_read_authenticated"
  ON public.cc_cycle_populations FOR SELECT TO authenticated USING (true);

CREATE POLICY "cc_cycle_populations_write_super_admin"
  ON public.cc_cycle_populations FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

CREATE TRIGGER trg_cc_cycle_populations_updated_at
  BEFORE UPDATE ON public.cc_cycle_populations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed populations (source views are read-only inputs, never modified)
INSERT INTO public.cc_cycle_populations
  (subject_type, code, label, source_view, subject_id_column, priority_column, filter_sql)
VALUES
  ('landlord', 'landlords_with_plans', 'Landlords with rent plans',
   'v_landlord_calling_base', 'landlord_id', 'plan_rent_total', 'plans > 0'),
  ('landlord', 'landlords_with_houses', 'Landlords with houses',
   'v_landlord_calling_base', 'landlord_id', 'houses_monthly_rent', 'houses > 0'),
  ('landlord', 'landlords_all', 'All landlords',
   'v_landlord_calling_base', 'landlord_id', 'monthly_rent', NULL),
  ('tenant', 'tenants_active_plans', 'Tenants on funded or repaying plans',
   'v_tenant_daily_eligibility', 'tenant_id', 'daily_repayment',
   'status IN (''funded'',''repaying'')'),
  ('agent', 'agents_with_active_tenants', 'Agents with active tenants',
   'v_agent_daily_eligibility', 'agent_id', 'expected_daily', 'active_count > 0');

-- Open a cycle and build its roster
CREATE OR REPLACE FUNCTION public.cc_open_cycle(
  p_subject_type cc_subject_type,
  p_population_code text,
  p_limit integer DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_pop public.cc_cycle_populations;
  v_cycle_id uuid;
  v_cycle_no integer;
  v_sql text;
BEGIN
  IF NOT (public.has_role(auth.uid(),'operations')
       OR public.has_role(auth.uid(),'hr')
       OR public.has_role(auth.uid(),'super_admin')) THEN
    RAISE EXCEPTION 'Not authorised to open a calling cycle.';
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

  SELECT coalesce(max(cycle_no), 0) + 1 INTO v_cycle_no
  FROM public.cc_call_cycles
  WHERE subject_type = p_subject_type;

  INSERT INTO public.cc_call_cycles
    (subject_type, cycle_no, opened_by, retry_after_days, attempt_cap)
  VALUES (p_subject_type, v_cycle_no, auth.uid(), 3, 2)
  RETURNING id INTO v_cycle_id;

  v_sql := format(
    'INSERT INTO public.cc_cycle_rows (cycle_id, subject_type, subject_id, state, priority_value)
     SELECT %L::uuid, %L::cc_subject_type, s.subject_id, ''to_call''::cc_row_state, s.priority_value
     FROM (
       SELECT DISTINCT ON (v.%I) v.%I AS subject_id, %s AS priority_value
       FROM public.%I v
       WHERE v.%I IS NOT NULL %s
       ORDER BY v.%I, %s DESC NULLS LAST
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
    CASE WHEN p_limit IS NULL THEN '' ELSE format('LIMIT %s', p_limit::integer) END
  );

  EXECUTE v_sql;

  RETURN v_cycle_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.cc_open_cycle(cc_subject_type, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_open_cycle(cc_subject_type, text, integer) TO authenticated;

-- Progress of open cycles
CREATE VIEW public.v_cc_cycle_progress
WITH (security_invoker = true) AS
SELECT
  c.id AS cycle_id,
  c.subject_type,
  c.cycle_no,
  c.opened_at,
  count(r.id) AS total_rows,
  count(*) FILTER (WHERE r.state = 'to_call') AS to_call_rows,
  count(*) FILTER (WHERE r.state = 'engaged') AS engaged_rows,
  count(*) FILTER (WHERE r.state = 'unreachable') AS unreachable_rows,
  count(*) FILTER (WHERE r.state = 'callback') AS callback_rows,
  count(*) FILTER (WHERE r.state = 'parked') AS parked_rows,
  count(*) FILTER (WHERE r.state = 'closed') AS closed_rows,
  count(*) FILTER (WHERE r.attempts_made > 0) AS attempted_rows,
  round(
    count(*) FILTER (WHERE r.attempts_made > 0)::numeric
    / NULLIF(count(r.id), 0) * 100, 1) AS coverage_pct,
  round(
    count(*) FILTER (WHERE r.state = 'engaged')::numeric
    / NULLIF(count(*) FILTER (WHERE r.attempts_made > 0), 0) * 100, 1) AS reach_pct
FROM public.cc_call_cycles c
LEFT JOIN public.cc_cycle_rows r ON r.cycle_id = c.id
WHERE c.closed_at IS NULL
GROUP BY c.id, c.subject_type, c.cycle_no, c.opened_at;

GRANT SELECT ON public.v_cc_cycle_progress TO authenticated;

-- Rows still blocking closure
CREATE OR REPLACE FUNCTION public.cc_cycle_outstanding(p_cycle_id uuid)
RETURNS TABLE (
  cycle_row_id uuid,
  subject_type cc_subject_type,
  subject_id uuid,
  state cc_row_state,
  attempts_made integer,
  last_attempt_at timestamptz,
  next_retry_at timestamptz,
  callback_due_at timestamptz,
  priority_value numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT r.id, r.subject_type, r.subject_id, r.state, r.attempts_made,
         r.last_attempt_at, r.next_retry_at, r.callback_due_at, r.priority_value
  FROM public.cc_cycle_rows r
  WHERE r.cycle_id = p_cycle_id
    AND r.state NOT IN ('engaged','parked','closed')
  ORDER BY r.priority_value DESC NULLS LAST, r.created_at
$function$;

REVOKE ALL ON FUNCTION public.cc_cycle_outstanding(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_cycle_outstanding(uuid) TO authenticated;