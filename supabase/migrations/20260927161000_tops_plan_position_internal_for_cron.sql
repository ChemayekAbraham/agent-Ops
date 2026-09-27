-- Bug fix, found by actually invoking tops_refresh_work_items() as pg_cron
-- would (no session, no JWT claim): tops_plan_position() is gated by
-- has_role(auth.uid(), ...), and auth.uid() is NULL with no JWT claim set —
-- so the tops-refresh-work-items-hourly cron job has never been able to
-- complete a single iteration; it fails 'not authorized' on the very first
-- plan it looks at, every hour, since tops_refresh_work_items() calls
-- tops_plan_position() directly.
--
-- Fix: split tops_plan_position's existing logic (same migration this
-- session, purely additive — a tops_ object, not a Classic one) into a new
-- internal-only function with no auth gate, and make tops_plan_position()
-- itself a thin role-gated wrapper around it. Every existing client caller
-- of tops_plan_position keeps the exact same signature, gate, and return
-- values — nothing about its public behavior changes. tops_refresh_work_items()
-- is updated to call the internal version, since it already runs as
-- SECURITY DEFINER with no client EXECUTE grant of its own.

CREATE OR REPLACE FUNCTION public.tops_plan_position_internal(p_rent_request_id uuid, p_as_at date DEFAULT NULL::date)
RETURNS TABLE(rent_request_id uuid, cadence text, cadence_source text, clock_start date, clock_source text, term_end_date date, expected_to_date_ugx numeric, paid_to_date_ugx numeric, position_ugx numeric, periods_due integer, days_past_due integer, days_behind integer, days_ahead integer, outstanding_ugx numeric, catch_up_daily_ugx numeric, term_expired boolean, as_at date, basis text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_as_at date := COALESCE(p_as_at, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_cadence text;
  v_cadence_source text;
  v_clock_start date;
  v_clock_source text;
  v_duration_days integer;
  v_daily_repayment numeric(14,2);
  v_total_repayment numeric(14,2);
  v_term_end_date date;
  v_expected numeric(14,2);
  v_paid numeric(14,2);
  v_position numeric(14,2);
  v_periods_due integer;
  v_oldest_unsettled_due date;
  v_days_past_due integer;
  v_deficit numeric(14,2);
  v_surplus numeric(14,2);
  v_days_behind integer;
  v_days_ahead integer;
  v_outstanding numeric(14,2);
  v_catch_up numeric(14,2);
  v_term_expired boolean;
BEGIN
  PERFORM 1 FROM public.rent_requests WHERE id = p_rent_request_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT rr.duration_days, rr.daily_repayment, rr.total_repayment
  INTO v_duration_days, v_daily_repayment, v_total_repayment
  FROM public.rent_requests rr
  WHERE rr.id = p_rent_request_id;

  SELECT c.clock_start, c.clock_source, c.cadence, c.cadence_source
  INTO v_clock_start, v_clock_source, v_cadence, v_cadence_source
  FROM public.tops_plan_clock c
  WHERE c.rent_request_id = p_rent_request_id;

  IF NOT FOUND OR v_cadence IS NULL THEN
    v_cadence := 'unknown';
    v_cadence_source := 'unknown';
  END IF;

  IF v_cadence = 'unknown' THEN
    RETURN QUERY SELECT
      p_rent_request_id, v_cadence, v_cadence_source, v_clock_start, v_clock_source,
      NULL::date, NULL::numeric, NULL::numeric, NULL::numeric, NULL::integer,
      NULL::integer, NULL::integer, NULL::integer, NULL::numeric, NULL::numeric,
      NULL::boolean, v_as_at, 'kampala;capped;reversals_excluded'::text;
    RETURN;
  END IF;

  v_term_end_date := v_clock_start + (v_duration_days - 1);
  v_term_expired := v_term_end_date < v_as_at;

  SELECT LEAST(COALESCE(SUM(i.amount_ugx), 0), v_total_repayment)
  INTO v_expected
  FROM public.tops_plan_instalments i
  WHERE i.rent_request_id = p_rent_request_id AND i.due_date <= v_as_at;

  SELECT COALESCE(SUM(s.amount_ugx), 0)
  INTO v_paid
  FROM public.tops_instalment_settlements s
  JOIN public.tops_plan_instalments i ON i.id = s.instalment_id
  JOIN public.agent_collections ac ON ac.id = s.collection_id
  WHERE i.rent_request_id = p_rent_request_id
    AND s.released_at IS NULL
    AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date <= v_as_at;

  v_position := v_paid - v_expected;

  SELECT count(*), MIN(i.due_date)
  INTO v_periods_due, v_oldest_unsettled_due
  FROM public.tops_plan_instalments i
  LEFT JOIN (
    SELECT s.instalment_id, SUM(s.amount_ugx) AS settled_ugx
    FROM public.tops_instalment_settlements s
    JOIN public.agent_collections ac ON ac.id = s.collection_id
    WHERE s.released_at IS NULL
      AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date <= v_as_at
    GROUP BY s.instalment_id
  ) sd ON sd.instalment_id = i.id
  WHERE i.rent_request_id = p_rent_request_id
    AND i.due_date <= v_as_at
    AND i.amount_ugx - COALESCE(sd.settled_ugx, 0) > 0;

  v_days_past_due := CASE WHEN v_oldest_unsettled_due IS NULL THEN 0 ELSE (v_as_at - v_oldest_unsettled_due) END;

  v_deficit := GREATEST(-v_position, 0);
  v_surplus := GREATEST(v_position, 0);
  v_days_behind := CASE WHEN v_deficit > 0 THEN CEIL(v_deficit / NULLIF(v_daily_repayment, 0))::integer ELSE 0 END;
  v_days_ahead := CASE WHEN v_surplus > 0 THEN FLOOR(v_surplus / NULLIF(v_daily_repayment, 0))::integer ELSE 0 END;

  v_outstanding := GREATEST(v_total_repayment - v_paid, 0);

  v_catch_up := CASE
    WHEN v_term_expired THEN NULL
    ELSE CEIL(v_outstanding / (v_term_end_date - v_as_at + 1))
  END;

  RETURN QUERY SELECT
    p_rent_request_id, v_cadence, v_cadence_source, v_clock_start, v_clock_source,
    v_term_end_date, v_expected, v_paid, v_position, v_periods_due,
    v_days_past_due, v_days_behind, v_days_ahead, v_outstanding, v_catch_up,
    v_term_expired, v_as_at, 'kampala;capped;reversals_excluded'::text;
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_plan_position_internal(uuid, date) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.tops_plan_position_internal(uuid, date) IS
'Internal-only — same computation as tops_plan_position(), without the has_role gate. Exists so SECURITY DEFINER internal callers with no session/JWT (tops_refresh_work_items, driven by cron) can compute plan position without failing the client-facing role check. No EXECUTE grant to any client-facing role; only called from other tops_ functions.';

CREATE OR REPLACE FUNCTION public.tops_plan_position(p_rent_request_id uuid, p_as_at date DEFAULT NULL::date)
RETURNS TABLE(rent_request_id uuid, cadence text, cadence_source text, clock_start date, clock_source text, term_end_date date, expected_to_date_ugx numeric, paid_to_date_ugx numeric, position_ugx numeric, periods_due integer, days_past_due integer, days_behind integer, days_ahead integer, outstanding_ugx numeric, catch_up_daily_ugx numeric, term_expired boolean, as_at date, basis text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY SELECT * FROM public.tops_plan_position_internal(p_rent_request_id, p_as_at);
END;
$function$;

COMMENT ON FUNCTION public.tops_plan_position(uuid, date) IS
'Client-facing, role-gated wrapper around tops_plan_position_internal() — same return shape and same has_role gate as before this fix. Existing callers (PositionCard, usePlanPosition, etc.) are unaffected.';

CREATE OR REPLACE FUNCTION public.tops_refresh_work_items()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rr record;
  v_pos record;
  v_bucket text;
  v_value_at_risk numeric(14,2);
  v_reason text;
  v_sla interval;
  v_existing_id uuid;
  v_count integer := 0;
BEGIN
  FOR v_rr IN
    SELECT rr.id AS rent_request_id
    FROM public.rent_requests rr
    JOIN public.tops_plan_clock c ON c.rent_request_id = rr.id
    WHERE rr.status IN ('funded', 'repaying')
      AND c.cadence <> 'unknown'
  LOOP
    SELECT * INTO v_pos FROM public.tops_plan_position_internal(v_rr.rent_request_id, NULL);
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    IF NOT (
      COALESCE(v_pos.days_past_due, 0) > 0
      OR (v_pos.term_expired IS TRUE AND COALESCE(v_pos.outstanding_ugx, 0) > 0)
    ) THEN
      CONTINUE;
    END IF;

    IF v_pos.term_expired IS TRUE THEN
      v_bucket := 'critical';
      v_value_at_risk := COALESCE(v_pos.outstanding_ugx, 0);
      v_reason := 'Term expired — ' || trim(to_char(COALESCE(v_pos.outstanding_ugx, 0), 'FM999,999,999')) || ' UGX due now, overdue regime applies';
      v_sla := interval '4 hours';
    ELSIF v_pos.days_past_due > 30 THEN
      v_bucket := 'critical';
      v_sla := interval '4 hours';
    ELSIF v_pos.days_past_due >= 15 THEN
      v_bucket := 'at_risk';
      v_sla := interval '24 hours';
    ELSIF v_pos.days_past_due >= 8 THEN
      v_bucket := 'watch';
      v_sla := interval '48 hours';
    ELSE
      v_bucket := 'new';
      v_sla := interval '72 hours';
    END IF;

    IF v_pos.term_expired IS NOT TRUE THEN
      v_value_at_risk := GREATEST(-COALESCE(v_pos.position_ugx, 0), 0);
      v_reason := v_pos.days_past_due || ' day' || CASE WHEN v_pos.days_past_due = 1 THEN '' ELSE 's' END
        || ' past due, ' || trim(to_char(v_value_at_risk, 'FM999,999,999')) || ' UGX behind';
    END IF;

    SELECT id INTO v_existing_id
    FROM public.tops_work_items
    WHERE rent_request_id = v_rr.rent_request_id AND status IN ('open', 'in_progress')
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      UPDATE public.tops_work_items
      SET bucket = v_bucket, reason = v_reason, value_at_risk_ugx = v_value_at_risk, updated_at = now()
      WHERE id = v_existing_id;
    ELSE
      INSERT INTO public.tops_work_items (rent_request_id, bucket, reason, value_at_risk_ugx, sla_due_at)
      VALUES (v_rr.rent_request_id, v_bucket, v_reason, v_value_at_risk, now() + v_sla);
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_refresh_work_items() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.tops_refresh_work_items() IS
'Rebuilds OPEN tops_work_items from tops_plan_position_internal (the internal, ungated variant — this function runs from cron with no session, so it cannot go through the has_role-gated client wrapper), ranked by value at risk. Never duplicates an open item for a plan (updates the existing one instead), never touches assigned_to/status/closed_*/escalated_* on an existing item — those are human-owned. Internal engine only (no EXECUTE grant), driven by the tops-refresh-work-items-hourly cron job.';
