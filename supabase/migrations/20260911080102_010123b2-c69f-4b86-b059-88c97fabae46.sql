-- 1. Faster queue view: per-row lateral lookups instead of whole-table joins.
CREATE OR REPLACE VIEW public.v_cc_call_queue
WITH (security_invoker = on) AS
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
    COALESCE(t.tenant_name, l.name, a.full_name, tpr.full_name) AS name,
    COALESCE(t.district, l.district, a.district, NULLIF(tpr.district, ''::text)) AS district,
    COALESCE(t.region, l.region, a.region, NULLIF(tpr.region, ''::text)) AS region,
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
    CASE
        WHEN r.subject_type = 'tenant'::cc_subject_type THEN GREATEST(0, - t.schedule_delta_days)
        ELSE NULL::integer
    END AS days_behind
   FROM cc_cycle_rows r
     LEFT JOIN LATERAL (
       SELECT b.tenant_id, b.tenant_name, b.district, b.region, b.agent_id,
              b.arrears_amount, b.outstanding, b.schedule_delta_days, b.daily_repayment,
              b.days_since_funded, b.last_payment_at, b.next_due_date
         FROM v_tenant_ops_tenant_base b
        WHERE r.subject_type = 'tenant'::cc_subject_type
          AND b.tenant_id = r.subject_id
        ORDER BY b.funded_at DESC NULLS LAST, b.rent_request_id
        LIMIT 1
     ) t ON true
     LEFT JOIN LATERAL (
       SELECT l2.name, l2.district, l2.region, l2.monthly_rent, l2.houses, l2.empty_houses,
              l2.plans, l2.plan_rent_total, l2.houses_monthly_rent, l2.last_paid_at,
              l2.managed_by_agent_id
         FROM v_landlord_calling_base l2
        WHERE r.subject_type = 'landlord'::cc_subject_type
          AND l2.landlord_id = r.subject_id
        LIMIT 1
     ) l ON true
     LEFT JOIN LATERAL (
       SELECT a2.full_name, a2.district, a2.region, a2.last_active_at, a2.agent_tier,
              a2.active_capability_count
         FROM vw_agent_ops_directory a2
        WHERE r.subject_type = 'agent'::cc_subject_type
          AND a2.agent_id = r.subject_id
        LIMIT 1
     ) a ON true
     LEFT JOIN profiles tap ON tap.id = t.agent_id
     LEFT JOIN profiles lap ON lap.id = l.managed_by_agent_id
     LEFT JOIN profiles tpr ON r.subject_type = 'tenant'::cc_subject_type AND tpr.id = r.subject_id
     LEFT JOIN LATERAL (
       SELECT sum(aa.outstanding_balance) AS advance_outstanding,
              sum(aa.arrears_balance) AS advance_arrears
         FROM agent_advances aa
        WHERE r.subject_type = 'agent'::cc_subject_type
          AND aa.agent_id = r.subject_id
          AND COALESCE(aa.status, ''::text) <> 'cancelled'::text
          AND aa.reversed_at IS NULL
     ) adv ON true
     LEFT JOIN LATERAL (
       SELECT sum(m.own_cash_outstanding) AS own_cash_outstanding
         FROM v_merchant_float_position m
        WHERE r.subject_type = 'agent'::cc_subject_type
          AND m.agent_id = r.subject_id
     ) mf ON true
     LEFT JOIN LATERAL (
       SELECT e.active_count
         FROM v_agent_daily_eligibility e
        WHERE r.subject_type = 'agent'::cc_subject_type
          AND e.agent_id = r.subject_id
        LIMIT 1
     ) el ON true
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

-- 2. Top up the open cycle with newly eligible subjects. Additive only.
CREATE OR REPLACE FUNCTION public.cc_topup_cycle(p_subject_type cc_subject_type)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cycle_id uuid;
  v_pop public.cc_cycle_populations;
  v_sql text;
  v_added integer := 0;
BEGIN
  IF NOT public.cc_queue_access_allowed(p_subject_type) THEN
    RAISE EXCEPTION 'not authorized to read the % call queue', p_subject_type;
  END IF;

  SELECT c.id INTO v_cycle_id
    FROM public.cc_call_cycles c
   WHERE c.subject_type = p_subject_type
     AND c.closed_at IS NULL
   ORDER BY c.opened_at DESC
   LIMIT 1;

  IF v_cycle_id IS NULL THEN
    RETURN 0;
  END IF;

  -- The population the cycle was opened on. Where more than one is active for a
  -- subject type, the one that produced the existing rows wins; otherwise the
  -- unbounded (max_rows IS NULL) one, so a top-up can never shrink the queue.
  SELECT * INTO v_pop
  FROM public.cc_cycle_populations
  WHERE subject_type = p_subject_type
    AND active
  ORDER BY (max_rows IS NULL) DESC, created_at
  LIMIT 1;

  IF v_pop.id IS NULL THEN
    RETURN 0;
  END IF;

  v_sql := format(
    'INSERT INTO public.cc_cycle_rows (cycle_id, subject_type, subject_id, state, priority_value)
     SELECT %L::uuid, %L::cc_subject_type, s.subject_id, ''to_call''::cc_row_state, s.priority_value
     FROM (
       SELECT DISTINCT ON (v.%I) v.%I AS subject_id, %s AS priority_value
       FROM public.%I v
       WHERE v.%I IS NOT NULL %s
       ORDER BY v.%I, %s DESC NULLS LAST, v::text
     ) s
     WHERE NOT EXISTS (
       SELECT 1 FROM public.cc_cycle_rows x
        WHERE x.cycle_id = %L::uuid
          AND x.subject_type = %L::cc_subject_type
          AND x.subject_id = s.subject_id
     )
     ON CONFLICT (cycle_id, subject_type, subject_id) DO NOTHING',
    v_cycle_id,
    p_subject_type,
    v_pop.subject_id_column,
    v_pop.subject_id_column,
    CASE WHEN v_pop.priority_column IS NULL THEN 'NULL::numeric'
         ELSE format('v.%I::numeric', v_pop.priority_column) END,
    v_pop.source_view,
    v_pop.subject_id_column,
    CASE WHEN v_pop.filter_sql IS NULL OR btrim(v_pop.filter_sql) = '' THEN ''
         ELSE 'AND (' || v_pop.filter_sql || ')' END,
    v_pop.subject_id_column,
    CASE WHEN v_pop.priority_column IS NULL THEN 'NULL::numeric'
         ELSE format('v.%I::numeric', v_pop.priority_column) END,
    v_cycle_id,
    p_subject_type
  );

  EXECUTE v_sql;
  GET DIAGNOSTICS v_added = ROW_COUNT;

  RETURN v_added;
END;
$function$;

REVOKE ALL ON FUNCTION public.cc_topup_cycle(cc_subject_type) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cc_topup_cycle(cc_subject_type) TO authenticated;

-- 3. Search-aware state counts (search is optional; default keeps old behaviour).
CREATE OR REPLACE FUNCTION public.cc_state_counts(p_subject_type cc_subject_type, p_filters jsonb DEFAULT NULL::jsonb, p_search text DEFAULT NULL::text)
 RETURNS TABLE(state cc_row_state, row_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cycle_id uuid;
  v_filter_sql text;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
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
         AND (%3$L::text IS NULL
              OR q.name ILIKE '%%' || %3$L::text || '%%'
              OR q.district ILIKE '%%' || %3$L::text || '%%')
         %2$s
    )
    SELECT s.s AS state, coalesce(count(b.state), 0)::bigint AS row_count
      FROM unnest(enum_range(NULL::cc_row_state)) AS s(s)
      LEFT JOIN base b ON b.state = s.s
     GROUP BY s.s
     ORDER BY s.s
  $f$, v_cycle_id, v_filter_sql, v_search);
END;
$function$;