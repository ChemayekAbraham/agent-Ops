-- ============================================================
-- Service Centre receivables (additive, no money movement)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.service_centre_receivables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_centre_id uuid NOT NULL REFERENCES public.service_centre_setups(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('markup','flat')),
  principal_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (principal_amount >= 0),
  markup_percent numeric(6,2) CHECK (markup_percent IS NULL OR markup_percent >= 0),
  total_repayable numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_repayable >= 0),
  recoverable_amount numeric(14,2) NOT NULL CHECK (recoverable_amount > 0),
  duration_value integer NOT NULL CHECK (duration_value > 0),
  duration_unit text NOT NULL CHECK (duration_unit IN ('days','months','years')),
  duration_days integer NOT NULL CHECK (duration_days > 0),
  daily_amount numeric(14,2) NOT NULL CHECK (daily_amount >= 0),
  start_date date NOT NULL DEFAULT ((now() AT TIME ZONE 'Africa/Kampala')::date),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
  notes text,
  cancel_reason text,
  created_by uuid,
  updated_by uuid,
  cancelled_by uuid,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.service_centre_receivables TO authenticated;
GRANT ALL ON public.service_centre_receivables TO service_role;
ALTER TABLE public.service_centre_receivables ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sc_receivable_active
  ON public.service_centre_receivables (service_centre_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_sc_receivable_centre ON public.service_centre_receivables (service_centre_id);
CREATE INDEX IF NOT EXISTS idx_sc_receivable_status ON public.service_centre_receivables (status);

CREATE POLICY "Ops can read service centre receivables"
  ON public.service_centre_receivables FOR SELECT TO authenticated
  USING (public.sc_assignment_admin(auth.uid()));

CREATE TABLE IF NOT EXISTS public.service_centre_receivable_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receivable_id uuid NOT NULL REFERENCES public.service_centre_receivables(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  share_percent numeric(6,3) NOT NULL CHECK (share_percent >= 0 AND share_percent <= 100),
  daily_amount numeric(14,2) NOT NULL CHECK (daily_amount >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.service_centre_receivable_splits TO authenticated;
GRANT ALL ON public.service_centre_receivable_splits TO service_role;
ALTER TABLE public.service_centre_receivable_splits ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sc_receivable_split_active
  ON public.service_centre_receivable_splits (receivable_id, agent_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_sc_split_receivable ON public.service_centre_receivable_splits (receivable_id);
CREATE INDEX IF NOT EXISTS idx_sc_split_agent ON public.service_centre_receivable_splits (agent_id);

CREATE POLICY "Ops can read service centre receivable splits"
  ON public.service_centre_receivable_splits FOR SELECT TO authenticated
  USING (public.sc_assignment_admin(auth.uid()));

CREATE POLICY "Agents can read their own service centre split"
  ON public.service_centre_receivable_splits FOR SELECT TO authenticated
  USING (agent_id = auth.uid());

CREATE TRIGGER trg_sc_receivables_updated_at
  BEFORE UPDATE ON public.service_centre_receivables
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER trg_sc_receivable_splits_updated_at
  BEFORE UPDATE ON public.service_centre_receivable_splits
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ------------------------------------------------------------
-- Who may create / change a plan
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sc_receivable_writer(_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT public.has_role(_user_id, 'agent_ops')
      OR public.has_role(_user_id, 'operations')
      OR public.has_role(_user_id, 'manager')
      OR public.has_role(_user_id, 'coo')
      OR public.has_role(_user_id, 'super_admin');
$$;

-- Duration (value + unit) -> days. 1 month = 30 days, 1 year = 365 days.
CREATE OR REPLACE FUNCTION public.sc_duration_to_days(p_value integer, p_unit text)
RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $$
  SELECT GREATEST(1, CASE p_unit
    WHEN 'days'   THEN p_value
    WHEN 'months' THEN p_value * 30
    WHEN 'years'  THEN p_value * 365
    ELSE p_value END);
$$;

-- ------------------------------------------------------------
-- Create / update the active receivable plan for one centre
--   p_splits: [{"agent_id": uuid, "share_percent": numeric}, ...]
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.service_centre_set_receivable(
  p_service_centre_id uuid,
  p_mode text,
  p_principal numeric DEFAULT 0,
  p_markup_percent numeric DEFAULT 33,
  p_flat_amount numeric DEFAULT NULL,
  p_duration_value integer DEFAULT 30,
  p_duration_unit text DEFAULT 'days',
  p_start_date date DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_splits jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_days integer;
  v_total numeric(14,2);
  v_recoverable numeric(14,2);
  v_daily numeric(14,2);
  v_id uuid;
  v_sum numeric := 0;
  v_rec jsonb;
BEGIN
  IF v_actor IS NULL OR NOT public.sc_receivable_writer(v_actor) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.service_centre_setups WHERE id = p_service_centre_id) THEN
    RAISE EXCEPTION 'service_centre_not_found';
  END IF;
  IF p_mode NOT IN ('markup','flat') THEN RAISE EXCEPTION 'invalid_mode'; END IF;
  IF p_duration_unit NOT IN ('days','months','years') THEN RAISE EXCEPTION 'invalid_duration_unit'; END IF;

  v_days := public.sc_duration_to_days(COALESCE(p_duration_value, 30), p_duration_unit);

  IF p_mode = 'markup' THEN
    IF COALESCE(p_principal, 0) <= 0 THEN RAISE EXCEPTION 'principal_required'; END IF;
    v_total := ROUND(COALESCE(p_principal,0) * (1 + COALESCE(p_markup_percent,33) / 100.0), 2);
    v_recoverable := ROUND(v_total - COALESCE(p_principal,0), 2);
  ELSE
    IF COALESCE(p_flat_amount, 0) <= 0 THEN RAISE EXCEPTION 'flat_amount_required'; END IF;
    v_recoverable := ROUND(p_flat_amount, 2);
    v_total := ROUND(COALESCE(p_principal,0) + v_recoverable, 2);
  END IF;

  IF v_recoverable <= 0 THEN RAISE EXCEPTION 'recoverable_must_be_positive'; END IF;
  v_daily := ROUND(v_recoverable / v_days, 2);

  -- one active plan per centre: reuse it so history/splits stay attached
  SELECT id INTO v_id FROM public.service_centre_receivables
   WHERE service_centre_id = p_service_centre_id AND status = 'active';

  IF v_id IS NULL THEN
    INSERT INTO public.service_centre_receivables (
      service_centre_id, mode, principal_amount, markup_percent, total_repayable,
      recoverable_amount, duration_value, duration_unit, duration_days, daily_amount,
      start_date, notes, created_by, updated_by
    ) VALUES (
      p_service_centre_id, p_mode, COALESCE(p_principal,0),
      CASE WHEN p_mode = 'markup' THEN COALESCE(p_markup_percent,33) ELSE NULL END,
      v_total, v_recoverable, COALESCE(p_duration_value,30), p_duration_unit, v_days, v_daily,
      COALESCE(p_start_date, (now() AT TIME ZONE 'Africa/Kampala')::date),
      p_notes, v_actor, v_actor
    ) RETURNING id INTO v_id;
  ELSE
    UPDATE public.service_centre_receivables SET
      mode = p_mode,
      principal_amount = COALESCE(p_principal,0),
      markup_percent = CASE WHEN p_mode = 'markup' THEN COALESCE(p_markup_percent,33) ELSE NULL END,
      total_repayable = v_total,
      recoverable_amount = v_recoverable,
      duration_value = COALESCE(p_duration_value,30),
      duration_unit = p_duration_unit,
      duration_days = v_days,
      daily_amount = v_daily,
      start_date = COALESCE(p_start_date, start_date),
      notes = COALESCE(p_notes, notes),
      updated_by = v_actor
    WHERE id = v_id;
  END IF;

  -- optional split distribution
  IF p_splits IS NOT NULL AND jsonb_typeof(p_splits) = 'array' AND jsonb_array_length(p_splits) > 0 THEN
    SELECT COALESCE(SUM((e->>'share_percent')::numeric), 0) INTO v_sum
      FROM jsonb_array_elements(p_splits) e;
    IF ABS(v_sum - 100) > 0.5 THEN RAISE EXCEPTION 'splits_must_total_100'; END IF;

    UPDATE public.service_centre_receivable_splits
       SET status = 'removed'
     WHERE receivable_id = v_id AND status = 'active';

    INSERT INTO public.service_centre_receivable_splits
      (receivable_id, agent_id, share_percent, daily_amount, created_by)
    SELECT v_id,
           (e->>'agent_id')::uuid,
           ROUND((e->>'share_percent')::numeric, 3),
           ROUND(v_daily * (e->>'share_percent')::numeric / 100.0, 2),
           v_actor
      FROM jsonb_array_elements(p_splits) e;
  ELSE
    -- keep existing shares but re-price them against the new daily amount
    UPDATE public.service_centre_receivable_splits
       SET daily_amount = ROUND(v_daily * share_percent / 100.0, 2)
     WHERE receivable_id = v_id AND status = 'active';
  END IF;

  SELECT to_jsonb(r) INTO v_rec FROM public.service_centre_receivables r WHERE r.id = v_id;
  RETURN jsonb_build_object('receivable', v_rec);
END;
$$;

REVOKE ALL ON FUNCTION public.service_centre_set_receivable(uuid,text,numeric,numeric,numeric,integer,text,date,text,jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.service_centre_set_receivable(uuid,text,numeric,numeric,numeric,integer,text,date,text,jsonb) TO authenticated;

-- ------------------------------------------------------------
-- Cancel / complete a plan
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.service_centre_close_receivable(
  p_receivable_id uuid,
  p_status text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL OR NOT public.sc_receivable_writer(v_actor) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF p_status NOT IN ('completed','cancelled') THEN RAISE EXCEPTION 'invalid_status'; END IF;
  IF p_status = 'cancelled' AND COALESCE(length(trim(p_reason)), 0) < 10 THEN
    RAISE EXCEPTION 'reason_required';
  END IF;

  UPDATE public.service_centre_receivables
     SET status = p_status,
         cancel_reason = COALESCE(p_reason, cancel_reason),
         cancelled_by = v_actor,
         cancelled_at = now(),
         updated_by = v_actor
   WHERE id = p_receivable_id AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'active_receivable_not_found'; END IF;

  UPDATE public.service_centre_receivable_splits
     SET status = 'removed'
   WHERE receivable_id = p_receivable_id AND status = 'active';

  RETURN jsonb_build_object('ok', true, 'status', p_status);
END;
$$;

REVOKE ALL ON FUNCTION public.service_centre_close_receivable(uuid,text,text) FROM public;
GRANT EXECUTE ON FUNCTION public.service_centre_close_receivable(uuid,text,text) TO authenticated;

-- ------------------------------------------------------------
-- One centre's plan + splits (single request)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_service_centre_receivable(p_service_centre_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_r record;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
BEGIN
  IF v_actor IS NULL OR NOT public.sc_assignment_admin(v_actor) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT * INTO v_r FROM public.service_centre_receivables
   WHERE service_centre_id = p_service_centre_id AND status = 'active'
   ORDER BY created_at DESC LIMIT 1;

  IF v_r IS NULL THEN
    RETURN jsonb_build_object('currency','UGX','receivable', NULL, 'splits', '[]'::jsonb, 'history', COALESCE((
      SELECT jsonb_agg(to_jsonb(h) ORDER BY h.created_at DESC)
        FROM public.service_centre_receivables h
       WHERE h.service_centre_id = p_service_centre_id
    ), '[]'::jsonb));
  END IF;

  RETURN jsonb_build_object(
    'currency','UGX',
    'receivable', to_jsonb(v_r) || jsonb_build_object(
      'end_date', v_r.start_date + (v_r.duration_days - 1),
      'days_elapsed', GREATEST(0, LEAST(v_r.duration_days, (v_today - v_r.start_date) + 1)),
      'expected_to_date', ROUND(v_r.daily_amount * GREATEST(0, LEAST(v_r.duration_days, (v_today - v_r.start_date) + 1)), 2),
      'created_by_name', (SELECT full_name FROM public.profiles WHERE id = v_r.created_by)
    ),
    'splits', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', s.id,
               'agent_id', s.agent_id,
               'agent_name', COALESCE(p.full_name, 'Unknown'),
               'agent_phone', p.phone,
               'share_percent', s.share_percent,
               'daily_amount', s.daily_amount,
               'created_at', s.created_at
             ) ORDER BY s.share_percent DESC)
        FROM public.service_centre_receivable_splits s
        LEFT JOIN public.profiles p ON p.id = s.agent_id
       WHERE s.receivable_id = v_r.id AND s.status = 'active'
    ), '[]'::jsonb),
    'history', COALESCE((
      SELECT jsonb_agg(to_jsonb(h) ORDER BY h.created_at DESC)
        FROM public.service_centre_receivables h
       WHERE h.service_centre_id = p_service_centre_id AND h.id <> v_r.id
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_service_centre_receivable(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_service_centre_receivable(uuid) TO authenticated;

-- ------------------------------------------------------------
-- Company-wide summary for COO / CFO (single request, no N+1)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_service_centre_receivables_summary()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
BEGIN
  IF v_actor IS NULL OR NOT public.sc_assignment_admin(v_actor) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  RETURN (
    WITH base AS (
      SELECT r.*,
             sc.agent_name, sc.location_name,
             GREATEST(0, LEAST(r.duration_days, (v_today - r.start_date) + 1)) AS days_elapsed
        FROM public.service_centre_receivables r
        JOIN public.service_centre_setups sc ON sc.id = r.service_centre_id
       WHERE r.status = 'active'
    ),
    sp AS (
      SELECT s.receivable_id,
             jsonb_agg(jsonb_build_object(
               'agent_id', s.agent_id,
               'agent_name', COALESCE(p.full_name,'Unknown'),
               'share_percent', s.share_percent,
               'daily_amount', s.daily_amount
             ) ORDER BY s.share_percent DESC) AS splits,
             COUNT(*) AS agent_count
        FROM public.service_centre_receivable_splits s
        LEFT JOIN public.profiles p ON p.id = s.agent_id
       WHERE s.status = 'active'
       GROUP BY s.receivable_id
    )
    SELECT jsonb_build_object(
      'currency','UGX',
      'as_at', now(),
      'business_date', v_today,
      'totals', jsonb_build_object(
        'centres', (SELECT COUNT(*) FROM base),
        'principal', COALESCE((SELECT SUM(principal_amount) FROM base), 0),
        'total_repayable', COALESCE((SELECT SUM(total_repayable) FROM base), 0),
        'recoverable', COALESCE((SELECT SUM(recoverable_amount) FROM base), 0),
        'due_daily', COALESCE((SELECT SUM(daily_amount) FROM base WHERE v_today BETWEEN start_date AND start_date + (duration_days - 1)), 0),
        'expected_to_date', COALESCE((SELECT SUM(ROUND(daily_amount * days_elapsed, 2)) FROM base), 0),
        'unallocated_daily', COALESCE((
          SELECT SUM(b.daily_amount) FROM base b
           LEFT JOIN sp ON sp.receivable_id = b.id
           WHERE sp.receivable_id IS NULL), 0)
      ),
      'rows', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'receivable_id', b.id,
          'service_centre_id', b.service_centre_id,
          'centre_agent_name', b.agent_name,
          'location_name', b.location_name,
          'mode', b.mode,
          'principal_amount', b.principal_amount,
          'markup_percent', b.markup_percent,
          'total_repayable', b.total_repayable,
          'recoverable_amount', b.recoverable_amount,
          'daily_amount', b.daily_amount,
          'duration_value', b.duration_value,
          'duration_unit', b.duration_unit,
          'duration_days', b.duration_days,
          'start_date', b.start_date,
          'end_date', b.start_date + (b.duration_days - 1),
          'days_elapsed', b.days_elapsed,
          'expected_to_date', ROUND(b.daily_amount * b.days_elapsed, 2),
          'agent_count', COALESCE(sp.agent_count, 0),
          'splits', COALESCE(sp.splits, '[]'::jsonb)
        ) ORDER BY b.daily_amount DESC)
        FROM base b LEFT JOIN sp ON sp.receivable_id = b.id
      ), '[]'::jsonb)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_service_centre_receivables_summary() FROM public;
GRANT EXECUTE ON FUNCTION public.get_service_centre_receivables_summary() TO authenticated;