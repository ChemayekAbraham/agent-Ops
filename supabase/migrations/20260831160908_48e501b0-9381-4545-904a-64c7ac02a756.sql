-- 1. Append days_behind to v_cc_call_queue
CREATE OR REPLACE VIEW public.v_cc_call_queue AS
WITH t AS (
         SELECT DISTINCT ON (b.tenant_id) b.tenant_id,
            b.tenant_name,
            b.district,
            b.region,
            b.agent_id,
            b.arrears_amount,
            b.outstanding,
            b.schedule_delta_days,
            b.daily_repayment,
            b.days_since_funded,
            b.last_payment_at,
            b.next_due_date
           FROM v_tenant_ops_tenant_base b
          ORDER BY b.tenant_id, b.funded_at DESC NULLS LAST, b.rent_request_id
        ), adv AS (
         SELECT agent_advances.agent_id,
            sum(agent_advances.outstanding_balance) AS advance_outstanding,
            sum(agent_advances.arrears_balance) AS advance_arrears
           FROM agent_advances
          WHERE COALESCE(agent_advances.status, ''::text) <> 'cancelled'::text AND agent_advances.reversed_at IS NULL
          GROUP BY agent_advances.agent_id
        ), mf AS (
         SELECT v_merchant_float_position.agent_id,
            sum(v_merchant_float_position.own_cash_outstanding) AS own_cash_outstanding
           FROM v_merchant_float_position
          GROUP BY v_merchant_float_position.agent_id
        )
 SELECT r.cycle_id,
    r.id AS cycle_row_id,
    r.subject_type,
    r.subject_id,
    r.state,
    r.attempts_made,
    r.last_attempt_at,
    r.next_retry_at,
    r.callback_due_at,
    r.park_reason,
    r.priority_value,
    COALESCE(t.tenant_name, l.name, a.full_name) AS name,
    COALESCE(t.district, l.district, a.district) AS district,
    COALESCE(t.region, l.region, a.region) AS region,
    COALESCE(tap.full_name, lap.full_name) AS linked_agent_name,
    fb.feedback_category,
    fb.severity,
    fb.routed_to_name,
    fb.ticket_ref,
    fb.task_status,
    pk.fix_ticket_ref,
    cb.booked_by_name,
    t.arrears_amount,
    t.outstanding,
    t.schedule_delta_days,
    t.daily_repayment,
    t.days_since_funded,
    t.last_payment_at,
    l.monthly_rent,
    l.houses,
    l.empty_houses,
    l.plans,
    l.plan_rent_total,
    l.houses_monthly_rent,
    l.last_paid_at,
    adv.advance_outstanding,
    adv.advance_arrears,
    el.active_count AS active_tenants,
    mf.own_cash_outstanding,
    a.last_active_at,
    a.agent_tier,
    a.active_capability_count,
    tpr.preferred_language,
    t.next_due_date,
    CASE WHEN r.subject_type = 'tenant'::cc_subject_type
         THEN greatest(0, -t.schedule_delta_days)::integer
         ELSE NULL::integer END AS days_behind
   FROM cc_cycle_rows r
     LEFT JOIN t ON r.subject_type = 'tenant'::cc_subject_type AND t.tenant_id = r.subject_id
     LEFT JOIN v_landlord_calling_base l ON r.subject_type = 'landlord'::cc_subject_type AND l.landlord_id = r.subject_id
     LEFT JOIN vw_agent_ops_directory a ON r.subject_type = 'agent'::cc_subject_type AND a.agent_id = r.subject_id
     LEFT JOIN profiles tap ON tap.id = t.agent_id
     LEFT JOIN profiles lap ON lap.id = l.managed_by_agent_id
     LEFT JOIN profiles tpr ON tpr.id = t.tenant_id
     LEFT JOIN adv ON r.subject_type = 'agent'::cc_subject_type AND adv.agent_id = r.subject_id
     LEFT JOIN mf ON r.subject_type = 'agent'::cc_subject_type AND mf.agent_id = r.subject_id
     LEFT JOIN v_agent_daily_eligibility el ON r.subject_type = 'agent'::cc_subject_type AND el.agent_id = r.subject_id
     LEFT JOIN LATERAL ( SELECT cat.label AS feedback_category,
            f.severity,
            sp.full_name AS routed_to_name,
            tk.ref AS ticket_ref,
            tsk.status::text AS task_status
           FROM cc_call_attempts at2
             JOIN cc_feedback f ON f.attempt_id = at2.id
             LEFT JOIN cc_feedback_categories cat ON cat.id = f.category_id
             LEFT JOIN hr_staff st ON st.id = COALESCE(f.routed_to_actual, f.routed_to_expected)
             LEFT JOIN profiles sp ON sp.id = st.user_id
             LEFT JOIN hr_tickets tk ON tk.id = f.ticket_id
             LEFT JOIN hr_tasks tsk ON tsk.id = tk.task_id
          WHERE at2.cycle_row_id = r.id
          ORDER BY f.created_at DESC
         LIMIT 1) fb ON true
     LEFT JOIN LATERAL ( SELECT tk2.ref AS fix_ticket_ref
           FROM hr_tickets tk2
             JOIN cc_call_attempts at3 ON at3.id = tk2.call_attempt_id
          WHERE at3.cycle_row_id = r.id AND tk2.severity_basis = 'Call centre parked row'::text
          ORDER BY tk2.raised_at DESC
         LIMIT 1) pk ON true
     LEFT JOIN LATERAL ( SELECT p.full_name AS booked_by_name
           FROM cc_call_attempts at4
             LEFT JOIN profiles p ON p.id = at4.caller_id
          WHERE at4.cycle_row_id = r.id AND at4.outcome = 'callback_booked'::cc_attempt_outcome
          ORDER BY at4.recorded_at DESC NULLS LAST
         LIMIT 1) cb ON true;

ALTER VIEW public.v_cc_call_queue SET (security_invoker = true);

-- 2. Fix the backwards sort option
UPDATE public.cc_sort_options
   SET sort_column = 'days_behind',
       direction = 'desc',
       updated_at = now()
 WHERE subject_type = 'tenant'::cc_subject_type
   AND key = 'schedule_delta_days';

-- 3. cc_filter_options
CREATE TABLE IF NOT EXISTS public.cc_filter_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type cc_subject_type NOT NULL,
  key text NOT NULL,
  label text NOT NULL,
  filter_column text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('value','bucket')),
  sort_order integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, key)
);

GRANT SELECT ON public.cc_filter_options TO authenticated;
GRANT ALL ON public.cc_filter_options TO service_role;
ALTER TABLE public.cc_filter_options ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cc_filter_options readable by authenticated"
  ON public.cc_filter_options FOR SELECT TO authenticated USING (true);
CREATE POLICY "cc_filter_options writable by super_admin"
  ON public.cc_filter_options FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'super_admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'super_admin'::app_role));

CREATE TRIGGER update_cc_filter_options_updated_at
  BEFORE UPDATE ON public.cc_filter_options
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 4. cc_filter_buckets
CREATE TABLE IF NOT EXISTS public.cc_filter_buckets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type cc_subject_type NOT NULL,
  filter_key text NOT NULL,
  bucket_key text NOT NULL,
  label text NOT NULL,
  min_value numeric NULL,
  max_value numeric NULL,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, filter_key, bucket_key)
);

GRANT SELECT ON public.cc_filter_buckets TO authenticated;
GRANT ALL ON public.cc_filter_buckets TO service_role;
ALTER TABLE public.cc_filter_buckets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cc_filter_buckets readable by authenticated"
  ON public.cc_filter_buckets FOR SELECT TO authenticated USING (true);
CREATE POLICY "cc_filter_buckets writable by super_admin"
  ON public.cc_filter_buckets FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'super_admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'super_admin'::app_role));

CREATE TRIGGER update_cc_filter_buckets_updated_at
  BEFORE UPDATE ON public.cc_filter_buckets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 5. Seed (tenant only)
INSERT INTO public.cc_filter_options (subject_type, key, label, filter_column, kind, sort_order)
VALUES
  ('tenant','district','District','district','value',10),
  ('tenant','preferred_language','Language','preferred_language','value',20),
  ('tenant','linked_agent','Linked agent','linked_agent_name','value',30),
  ('tenant','region','Region','region','value',40),
  ('tenant','arrears_band','Payment status','arrears_amount','bucket',50),
  ('tenant','days_behind_band','Days behind','days_behind','bucket',60)
ON CONFLICT (subject_type, key) DO UPDATE
  SET label = EXCLUDED.label,
      filter_column = EXCLUDED.filter_column,
      kind = EXCLUDED.kind,
      sort_order = EXCLUDED.sort_order,
      active = true;

INSERT INTO public.cc_filter_buckets (subject_type, filter_key, bucket_key, label, min_value, max_value, sort_order)
VALUES
  ('tenant','arrears_band','owing','Has outstanding balance',0.01,NULL,10),
  ('tenant','arrears_band','cleared','Nothing outstanding',NULL,0,20),
  ('tenant','days_behind_band','on_schedule','On schedule',0,0,10),
  ('tenant','days_behind_band','behind_1_7','1-7 days behind',1,7,20),
  ('tenant','days_behind_band','behind_8_30','8-30 days behind',8,30,30),
  ('tenant','days_behind_band','behind_31','31+ days behind',31,NULL,40)
ON CONFLICT (subject_type, filter_key, bucket_key) DO UPDATE
  SET label = EXCLUDED.label,
      min_value = EXCLUDED.min_value,
      max_value = EXCLUDED.max_value,
      sort_order = EXCLUDED.sort_order;

-- Shared predicate builder
CREATE OR REPLACE FUNCTION public.cc_filter_predicate(p_subject_type cc_subject_type, p_filters jsonb)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_key text;
  v_val text;
  v_col text;
  v_kind text;
  v_min numeric;
  v_max numeric;
  v_found boolean;
  v_sql text := '';
BEGIN
  IF p_filters IS NULL OR jsonb_typeof(p_filters) <> 'object' THEN
    RETURN '';
  END IF;

  FOR v_key, v_val IN SELECT k, nullif(btrim(coalesce(v #>> '{}', '')), '')
                        FROM jsonb_each(p_filters) AS e(k, v)
  LOOP
    SELECT f.filter_column, f.kind INTO v_col, v_kind
      FROM cc_filter_options f
     WHERE f.subject_type = p_subject_type
       AND f.key = v_key
       AND f.active
     LIMIT 1;

    IF v_col IS NULL THEN
      RAISE EXCEPTION 'filter option % does not exist or is inactive for subject type %', v_key, p_subject_type;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'v_cc_call_queue' AND column_name = v_col
    ) THEN
      RAISE EXCEPTION 'filter column % is not a column of v_cc_call_queue', v_col;
    END IF;

    IF v_val IS NULL THEN
      CONTINUE;
    END IF;

    IF v_kind = 'value' THEN
      v_sql := v_sql || format(' AND (q.%I)::text = %L', v_col, v_val);
    ELSE
      SELECT true, b.min_value, b.max_value INTO v_found, v_min, v_max
        FROM cc_filter_buckets b
       WHERE b.subject_type = p_subject_type
         AND b.filter_key = v_key
         AND b.bucket_key = v_val
       LIMIT 1;

      IF NOT coalesce(v_found, false) THEN
        RAISE EXCEPTION 'bucket % does not exist for filter % on subject type %', v_val, v_key, p_subject_type;
      END IF;

      IF v_min IS NOT NULL THEN
        v_sql := v_sql || format(' AND (q.%I)::numeric >= %L::numeric', v_col, v_min);
      END IF;
      IF v_max IS NOT NULL THEN
        v_sql := v_sql || format(' AND (q.%I)::numeric <= %L::numeric', v_col, v_max);
      END IF;
      IF v_min IS NULL AND v_max IS NULL THEN
        v_sql := v_sql || format(' AND q.%I IS NOT NULL', v_col);
      END IF;
    END IF;
  END LOOP;

  RETURN v_sql;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.cc_filter_predicate(cc_subject_type, jsonb) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_filter_predicate(cc_subject_type, jsonb) TO authenticated;

-- 6. cc_filter_values
CREATE OR REPLACE FUNCTION public.cc_filter_values(p_subject_type cc_subject_type, p_filter_key text)
RETURNS TABLE(value text, row_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_cycle_id uuid;
  v_col text;
  v_kind text;
BEGIN
  IF NOT cc_queue_access_allowed(p_subject_type) THEN
    RAISE EXCEPTION 'not authorized to read the % call queue', p_subject_type;
  END IF;

  SELECT f.filter_column, f.kind INTO v_col, v_kind
    FROM cc_filter_options f
   WHERE f.subject_type = p_subject_type
     AND f.key = p_filter_key
     AND f.active
   LIMIT 1;

  IF v_col IS NULL THEN
    RAISE EXCEPTION 'filter option % does not exist or is inactive for subject type %', p_filter_key, p_subject_type;
  END IF;

  IF v_kind <> 'value' THEN
    RAISE EXCEPTION 'filter option % is a bucket filter; read its options from cc_filter_buckets', p_filter_key;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'v_cc_call_queue' AND column_name = v_col
  ) THEN
    RAISE EXCEPTION 'filter column % is not a column of v_cc_call_queue', v_col;
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

  RETURN QUERY EXECUTE format($f$
    SELECT (q.%1$I)::text AS value, count(*)::bigint AS row_count
      FROM v_cc_call_queue q
     WHERE q.cycle_id = %2$L
       AND q.%1$I IS NOT NULL
       AND btrim((q.%1$I)::text) <> ''
     GROUP BY (q.%1$I)::text
     ORDER BY 1
  $f$, v_col, v_cycle_id);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.cc_filter_values(cc_subject_type, text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_filter_values(cc_subject_type, text) TO authenticated;

-- 7. Extend cc_call_queue_page and cc_state_counts with p_filters
DROP FUNCTION IF EXISTS public.cc_call_queue_page(cc_subject_type, cc_row_state, text, text, integer, integer);
DROP FUNCTION IF EXISTS public.cc_state_counts(cc_subject_type);

CREATE OR REPLACE FUNCTION public.cc_call_queue_page(
  p_subject_type cc_subject_type,
  p_state cc_row_state,
  p_sort_key text DEFAULT NULL::text,
  p_search text DEFAULT NULL::text,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_filters jsonb DEFAULT NULL::jsonb
)
RETURNS TABLE(cycle_row_id uuid, subject_id uuid, state cc_row_state, attempts_made integer, last_attempt_at timestamp with time zone, next_retry_at timestamp with time zone, callback_due_at timestamp with time zone, park_reason text, name text, district text, linked_agent_name text, feedback_category text, severity hr_ticket_severity, routed_to_name text, ticket_ref text, task_status text, fix_ticket_ref text, booked_by_name text, metric_value numeric, metric_date timestamp with time zone, metric_text text, metric_label text, metric_format text, total_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  v_filter_sql text;
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

  v_filter_sql := cc_filter_predicate(p_subject_type, p_filters);

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
         %12$s
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
    v_offset,
    coalesce(v_filter_sql, '')
  );

  RETURN QUERY EXECUTE v_sql;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cc_call_queue_page(cc_subject_type, cc_row_state, text, text, integer, integer, jsonb) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_call_queue_page(cc_subject_type, cc_row_state, text, text, integer, integer, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.cc_state_counts(
  p_subject_type cc_subject_type,
  p_filters jsonb DEFAULT NULL::jsonb
)
RETURNS TABLE(state cc_row_state, row_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cycle_id uuid;
  v_filter_sql text;
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

  v_filter_sql := coalesce(cc_filter_predicate(p_subject_type, p_filters), '');

  RETURN QUERY EXECUTE format($f$
    WITH base AS (
      SELECT q.state
        FROM v_cc_call_queue q
       WHERE q.cycle_id = %1$L
         %2$s
    )
    SELECT s.s AS state, coalesce(count(b.state), 0)::bigint AS row_count
      FROM unnest(enum_range(NULL::cc_row_state)) AS s(s)
      LEFT JOIN base b ON b.state = s.s
     GROUP BY s.s
     ORDER BY s.s
  $f$, v_cycle_id, v_filter_sql);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cc_state_counts(cc_subject_type, jsonb) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_state_counts(cc_subject_type, jsonb) TO authenticated;