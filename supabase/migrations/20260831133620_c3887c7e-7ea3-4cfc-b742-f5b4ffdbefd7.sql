-- 1. Repoint populations
UPDATE public.cc_cycle_populations
SET source_view = 'v_tenant_ops_tenant_base',
    subject_id_column = 'tenant_id',
    priority_column = 'arrears_amount',
    filter_sql = 'is_active',
    updated_at = now()
WHERE subject_type = 'tenant' AND code = 'tenants_active_plans';

UPDATE public.cc_cycle_populations
SET code = 'agents_directory',
    label = 'All active agents',
    source_view = 'vw_agent_ops_directory',
    subject_id_column = 'agent_id',
    priority_column = NULL,
    filter_sql = 'not coalesce(is_frozen,false)',
    updated_at = now()
WHERE subject_type = 'agent' AND code = 'agents_with_active_tenants';

-- 2. max_rows
ALTER TABLE public.cc_cycle_populations ADD COLUMN IF NOT EXISTS max_rows integer;
UPDATE public.cc_cycle_populations SET max_rows = 500, updated_at = now()
WHERE subject_type = 'landlord' AND code = 'landlords_all';

CREATE OR REPLACE FUNCTION public.cc_open_cycle(p_subject_type cc_subject_type, p_population_code text, p_limit integer DEFAULT NULL::integer)
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

  v_limit := p_limit;
  IF v_pop.max_rows IS NOT NULL AND (v_limit IS NULL OR v_limit > v_pop.max_rows) THEN
    v_limit := v_pop.max_rows;
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

-- 3. cc_sort_options
CREATE TABLE IF NOT EXISTS public.cc_sort_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type public.cc_subject_type NOT NULL,
  key text NOT NULL,
  label text NOT NULL,
  sort_column text NOT NULL,
  direction text NOT NULL DEFAULT 'desc' CHECK (direction IN ('asc','desc')),
  nulls_last boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, key)
);

CREATE UNIQUE INDEX IF NOT EXISTS cc_sort_options_one_default
  ON public.cc_sort_options (subject_type) WHERE is_default;

GRANT SELECT ON public.cc_sort_options TO authenticated;
GRANT ALL ON public.cc_sort_options TO service_role;
ALTER TABLE public.cc_sort_options ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cc_sort_options_read" ON public.cc_sort_options;
CREATE POLICY "cc_sort_options_read" ON public.cc_sort_options
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "cc_sort_options_write" ON public.cc_sort_options;
CREATE POLICY "cc_sort_options_write" ON public.cc_sort_options
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'super_admin'))
  WITH CHECK (public.has_role(auth.uid(),'super_admin'));

CREATE OR REPLACE FUNCTION public.touch_cc_sort_options()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_touch_cc_sort_options ON public.cc_sort_options;
CREATE TRIGGER trg_touch_cc_sort_options BEFORE UPDATE ON public.cc_sort_options
FOR EACH ROW EXECUTE FUNCTION public.touch_cc_sort_options();

-- 4. v_cc_call_queue  (NO phone / money identifiers exposed)
DROP VIEW IF EXISTS public.v_cc_call_queue;
CREATE VIEW public.v_cc_call_queue WITH (security_invoker = true) AS
WITH t AS (
  SELECT DISTINCT ON (b.tenant_id)
    b.tenant_id, b.tenant_name, b.district, b.region, b.agent_id,
    b.arrears_amount, b.outstanding, b.schedule_delta_days, b.daily_repayment,
    b.days_since_funded, b.last_payment_at
  FROM public.v_tenant_ops_tenant_base b
  ORDER BY b.tenant_id, b.funded_at DESC NULLS LAST, b.rent_request_id
),
adv AS (
  SELECT agent_id,
         sum(outstanding_balance) AS advance_outstanding,
         sum(arrears_balance) AS advance_arrears
  FROM public.agent_advances
  WHERE coalesce(status,'') <> 'cancelled'
    AND reversed_at IS NULL
  GROUP BY agent_id
),
mf AS (
  SELECT agent_id, sum(own_cash_outstanding) AS own_cash_outstanding
  FROM public.v_merchant_float_position
  GROUP BY agent_id
)
SELECT
  r.cycle_id,
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
  coalesce(t.tenant_name, l.name, a.full_name) AS name,
  coalesce(t.district, l.district, a.district) AS district,
  coalesce(t.region, l.region, a.region) AS region,
  coalesce(tap.full_name, lap.full_name) AS linked_agent_name,
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
  a.active_capability_count
FROM public.cc_cycle_rows r
LEFT JOIN t ON r.subject_type = 'tenant' AND t.tenant_id = r.subject_id
LEFT JOIN public.v_landlord_calling_base l ON r.subject_type = 'landlord' AND l.landlord_id = r.subject_id
LEFT JOIN public.vw_agent_ops_directory a ON r.subject_type = 'agent' AND a.agent_id = r.subject_id
LEFT JOIN public.profiles tap ON tap.id = t.agent_id
LEFT JOIN public.profiles lap ON lap.id = l.managed_by_agent_id
LEFT JOIN adv ON r.subject_type = 'agent' AND adv.agent_id = r.subject_id
LEFT JOIN mf ON r.subject_type = 'agent' AND mf.agent_id = r.subject_id
LEFT JOIN public.v_agent_daily_eligibility el ON r.subject_type = 'agent' AND el.agent_id = r.subject_id
LEFT JOIN LATERAL (
  SELECT cat.label AS feedback_category,
         f.severity AS severity,
         sp.full_name AS routed_to_name,
         tk.ref AS ticket_ref,
         tsk.status::text AS task_status
  FROM public.cc_call_attempts at2
  JOIN public.cc_feedback f ON f.attempt_id = at2.id
  LEFT JOIN public.cc_feedback_categories cat ON cat.id = f.category_id
  LEFT JOIN public.hr_staff st ON st.id = coalesce(f.routed_to_actual, f.routed_to_expected)
  LEFT JOIN public.profiles sp ON sp.id = st.user_id
  LEFT JOIN public.hr_tickets tk ON tk.id = f.ticket_id
  LEFT JOIN public.hr_tasks tsk ON tsk.id = tk.task_id
  WHERE at2.cycle_row_id = r.id
  ORDER BY f.created_at DESC
  LIMIT 1
) fb ON true
LEFT JOIN LATERAL (
  SELECT tk2.ref AS fix_ticket_ref
  FROM public.hr_tickets tk2
  JOIN public.cc_call_attempts at3 ON at3.id = tk2.call_attempt_id
  WHERE at3.cycle_row_id = r.id
    AND tk2.severity_basis = 'Call centre parked row'
  ORDER BY tk2.raised_at DESC
  LIMIT 1
) pk ON true
LEFT JOIN LATERAL (
  SELECT p.full_name AS booked_by_name
  FROM public.cc_call_attempts at4
  LEFT JOIN public.profiles p ON p.id = at4.caller_id
  WHERE at4.cycle_row_id = r.id
    AND at4.outcome = 'callback_booked'
  ORDER BY at4.recorded_at DESC NULLS LAST
  LIMIT 1
) cb ON true;

GRANT SELECT ON public.v_cc_call_queue TO authenticated;

-- 5. Seed sort options
INSERT INTO public.cc_sort_options (subject_type, key, label, sort_column, direction, is_default, sort_order) VALUES
  ('tenant','arrears_amount','Owing most','arrears_amount','desc',true,10),
  ('tenant','schedule_delta_days','Furthest behind schedule','schedule_delta_days','desc',false,20),
  ('tenant','outstanding','Largest outstanding','outstanding','desc',false,30),
  ('tenant','last_payment_at','Longest since any payment','last_payment_at','asc',false,40),
  ('tenant','daily_repayment','Largest daily amount','daily_repayment','desc',false,50),
  ('tenant','days_since_funded','Longest funded','days_since_funded','desc',false,60),
  ('tenant','name','Name A-Z','name','asc',false,70),
  ('landlord','plan_rent_total','Highest rent value','plan_rent_total','desc',true,10),
  ('landlord','houses_monthly_rent','Highest house rent','houses_monthly_rent','desc',false,20),
  ('landlord','monthly_rent','Highest declared rent','monthly_rent','desc',false,30),
  ('landlord','houses','Most houses','houses','desc',false,40),
  ('landlord','empty_houses','Most empty houses','empty_houses','desc',false,50),
  ('landlord','plans','Most plans','plans','desc',false,60),
  ('landlord','last_paid_at','Longest since payout','last_paid_at','asc',false,70),
  ('landlord','name','Name A-Z','name','asc',false,80),
  ('agent','advance_outstanding','Owes us most','advance_outstanding','desc',true,10),
  ('agent','advance_arrears','Deepest advance arrears','advance_arrears','desc',false,20),
  ('agent','active_tenants','Most tenants under them','active_tenants','desc',false,30),
  ('agent','own_cash_outstanding','We owe them most','own_cash_outstanding','desc',false,40),
  ('agent','last_active_at','Longest inactive','last_active_at','asc',false,50),
  ('agent','active_capability_count','Most capabilities','active_capability_count','desc',false,60),
  ('agent','name','Name A-Z','name','asc',false,70)
ON CONFLICT (subject_type, key) DO NOTHING;

-- 6. RPCs
CREATE OR REPLACE FUNCTION public.cc_attempt_guard(p_attempt_id uuid)
RETURNS public.cc_call_attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE att public.cc_call_attempts;
BEGIN
  SELECT * INTO att FROM public.cc_call_attempts WHERE id = p_attempt_id;
  IF att.id IS NULL THEN
    RAISE EXCEPTION 'Call attempt % not found.', p_attempt_id;
  END IF;
  IF NOT (att.caller_id = auth.uid()
       OR public.has_role(auth.uid(),'operations')
       OR public.has_role(auth.uid(),'hr')
       OR public.has_role(auth.uid(),'super_admin')) THEN
    RAISE EXCEPTION 'Not authorised to act on this call attempt.';
  END IF;
  RETURN att;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cc_attempt_guard(uuid) FROM anon, PUBLIC;

CREATE OR REPLACE FUNCTION public.cc_reveal_phone(p_attempt_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  att public.cc_call_attempts;
  row_rec public.cc_cycle_rows;
  v_phone text;
BEGIN
  att := public.cc_attempt_guard(p_attempt_id);
  SELECT * INTO row_rec FROM public.cc_cycle_rows WHERE id = att.cycle_row_id;
  IF row_rec.id IS NULL THEN
    RAISE EXCEPTION 'Cycle row for attempt % not found.', p_attempt_id;
  END IF;

  IF row_rec.subject_type = 'landlord' THEN
    SELECT l.phone INTO v_phone FROM public.v_landlord_calling_base l WHERE l.landlord_id = row_rec.subject_id LIMIT 1;
  ELSIF row_rec.subject_type = 'tenant' THEN
    SELECT b.tenant_phone INTO v_phone FROM public.v_tenant_ops_tenant_base b WHERE b.tenant_id = row_rec.subject_id AND b.tenant_phone IS NOT NULL LIMIT 1;
  ELSE
    SELECT a.phone INTO v_phone FROM public.vw_agent_ops_directory a WHERE a.agent_id = row_rec.subject_id LIMIT 1;
  END IF;

  RETURN nullif(btrim(coalesce(v_phone,'')), '');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cc_reveal_phone(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_reveal_phone(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.cc_record_unreached(p_attempt_id uuid, p_outcome public.cc_attempt_outcome)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE att public.cc_call_attempts;
BEGIN
  att := public.cc_attempt_guard(p_attempt_id);
  IF p_outcome IN ('engaged','callback_booked') THEN
    RAISE EXCEPTION 'Outcome % is not an unreached outcome.', p_outcome;
  END IF;

  UPDATE public.cc_call_attempts
  SET recorded_at = now(), outcome = p_outcome, channel = 'phone'
  WHERE id = p_attempt_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cc_record_unreached(uuid, public.cc_attempt_outcome) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_record_unreached(uuid, public.cc_attempt_outcome) TO authenticated;

CREATE OR REPLACE FUNCTION public.cc_record_engaged(
  p_attempt_id uuid,
  p_category_id uuid,
  p_severity public.hr_ticket_severity,
  p_note text,
  p_routed_to_staff_id uuid,
  p_consent boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  att public.cc_call_attempts;
  v_locked boolean;
  v_feedback_id uuid;
BEGIN
  att := public.cc_attempt_guard(p_attempt_id);

  IF p_note IS NULL OR btrim(p_note) = '' THEN
    RAISE EXCEPTION 'A note describing what the person said is required.';
  END IF;

  SELECT locked INTO v_locked FROM public.cc_feedback_categories WHERE id = p_category_id;
  IF v_locked IS NULL THEN
    RAISE EXCEPTION 'Unknown feedback category %.', p_category_id;
  END IF;

  -- Attempt FIRST: the feedback trigger copies recorded_at and channel into the ticket.
  UPDATE public.cc_call_attempts
  SET recorded_at = now(), outcome = 'engaged', channel = 'phone'
  WHERE id = p_attempt_id;

  INSERT INTO public.cc_feedback (attempt_id, category_id, severity, note, routed_to_actual, consent_to_contact)
  VALUES (
    p_attempt_id,
    p_category_id,
    p_severity,
    btrim(p_note),
    CASE WHEN v_locked THEN NULL ELSE p_routed_to_staff_id END,
    coalesce(p_consent,false)
  )
  RETURNING id INTO v_feedback_id;

  RETURN v_feedback_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cc_record_engaged(uuid, uuid, public.hr_ticket_severity, text, uuid, boolean) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_record_engaged(uuid, uuid, public.hr_ticket_severity, text, uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.cc_record_callback(p_attempt_id uuid, p_due_at timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE att public.cc_call_attempts;
BEGIN
  att := public.cc_attempt_guard(p_attempt_id);

  IF p_due_at IS NULL OR p_due_at <= now() THEN
    RAISE EXCEPTION 'The callback time must be in the future.';
  END IF;

  UPDATE public.cc_call_attempts
  SET recorded_at = now(), outcome = 'callback_booked', channel = 'phone'
  WHERE id = p_attempt_id;

  UPDATE public.cc_cycle_rows
  SET callback_due_at = p_due_at
  WHERE id = att.cycle_row_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cc_record_callback(uuid, timestamptz) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_record_callback(uuid, timestamptz) TO authenticated;