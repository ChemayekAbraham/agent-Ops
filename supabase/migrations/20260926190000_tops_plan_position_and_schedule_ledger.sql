-- Tenant Ops Workspace — read RPCs for the new tab: a plan's current
-- position, and its full per-instalment ledger.
--
-- Per docs/TOPS_RULES.md: new functions only. Both are pure reads — no
-- INSERT/UPDATE/DELETE anywhere in this file, no write to any tops_* or
-- existing table. Unlike the internal-engine functions built so far, these
-- ARE meant to be called by the frontend, so each is SECURITY DEFINER with
-- an internal has_role() check (tenant_ops/operations/coo/cfo/ceo/
-- super_admin) rather than being locked out of anon/authenticated entirely —
-- EXECUTE is revoked from PUBLIC and anon, and granted to authenticated;
-- the has_role check is what actually gates a useful result, not the grant.
--
-- Both are point-in-time snapshots, consistent within themselves:
-- tops_plan_position's p_as_at defaults to today's Kampala date but can be
-- any past date, and every money figure in that one row (paid_to_date_ugx,
-- position_ugx, outstanding_ugx, catch_up_daily_ugx) is computed using only
-- settlements whose underlying agent_collections.created_at falls on or
-- before that same p_as_at — so a historical query reflects only what was
-- known as of that date, not money collected since.

-- ---------------------------------------------------------------------------
-- 1. tops_plan_position
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_plan_position(p_rent_request_id uuid, p_as_at date DEFAULT NULL)
RETURNS TABLE (
  rent_request_id uuid,
  cadence text,
  cadence_source text,
  clock_start date,
  clock_source text,
  term_end_date date,
  expected_to_date_ugx numeric,
  paid_to_date_ugx numeric,
  position_ugx numeric,
  periods_due integer,
  days_past_due integer,
  days_behind integer,
  days_ahead integer,
  outstanding_ugx numeric,
  catch_up_daily_ugx numeric,
  term_expired boolean,
  as_at date,
  basis text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- Expected to date: instalments due on/before as_at, capped at total_repayment.
  SELECT LEAST(COALESCE(SUM(i.amount_ugx), 0), v_total_repayment)
  INTO v_expected
  FROM public.tops_plan_instalments i
  WHERE i.rent_request_id = p_rent_request_id AND i.due_date <= v_as_at;

  -- Paid to date: net settled (released rows excluded), bounded by the
  -- underlying collection's own date so a past as_at is a true snapshot.
  SELECT COALESCE(SUM(s.amount_ugx), 0)
  INTO v_paid
  FROM public.tops_instalment_settlements s
  JOIN public.tops_plan_instalments i ON i.id = s.instalment_id
  JOIN public.agent_collections ac ON ac.id = s.collection_id
  WHERE i.rent_request_id = p_rent_request_id
    AND s.released_at IS NULL
    AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date <= v_as_at;

  v_position := v_paid - v_expected;

  -- Periods due: instalments due on/before as_at with any amount unsettled
  -- as of as_at (same date bound as paid_to_date, for internal consistency).
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

  -- Outstanding: total_repayment less what has actually been paid as of
  -- as_at (not just "expected to date") — the whole remaining balance.
  v_outstanding := GREATEST(v_total_repayment - v_paid, 0);

  -- Catch-up daily rate: outstanding spread evenly across the days left in
  -- the term (including today), so paying this much per day from now clears
  -- the balance exactly by term_end_date. Null once the term has expired —
  -- there are no remaining days left to spread it across.
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
$$;

REVOKE ALL ON FUNCTION public.tops_plan_position(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_plan_position(uuid, date) TO authenticated;

COMMENT ON FUNCTION public.tops_plan_position(uuid, date) IS
'Read RPC for the Tenant Ops Workspace: one plan''s position as of a date (default today, Kampala). Gated by an internal has_role check (tenant_ops/operations/coo/cfo/ceo/super_admin) — EXECUTE is granted to authenticated, but an unauthorized caller gets an exception. Schedule-derived fields are null when cadence is unknown, so the caller states that plainly instead of showing a fabricated number.';

-- ---------------------------------------------------------------------------
-- 2. tops_plan_schedule_ledger
--
-- running_arrears_ugx floors at zero at every step (real arrears cannot go
-- negative; being ahead is what tops_plan_position's position_ugx/
-- days_ahead already represent) — this needs a running, clamped total rather
-- than a plain cumulative sum, hence the explicit loop below rather than a
-- window function.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_plan_schedule_ledger(p_rent_request_id uuid)
RETURNS TABLE (
  seq integer,
  due_date date,
  amount_ugx numeric,
  settled_ugx numeric,
  outstanding_ugx numeric,
  running_arrears_ugx numeric,
  settled_by jsonb,
  never_billed boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_first_pin date;
  v_running numeric(14,2) := 0;
  v_row record;
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

  SELECT MIN(aedp.day) INTO v_first_pin
  FROM public.agent_expected_day_plans aedp
  WHERE aedp.rent_request_id = p_rent_request_id;

  FOR v_row IN
    SELECT
      i.seq,
      i.due_date,
      i.amount_ugx,
      COALESCE(sd.settled_ugx, 0) AS settled_ugx,
      COALESCE(sb.settled_by, '[]'::jsonb) AS settled_by
    FROM public.tops_plan_instalments i
    LEFT JOIN (
      SELECT s.instalment_id, SUM(s.amount_ugx) AS settled_ugx
      FROM public.tops_instalment_settlements s
      WHERE s.released_at IS NULL
      GROUP BY s.instalment_id
    ) sd ON sd.instalment_id = i.id
    LEFT JOIN (
      SELECT
        s.instalment_id,
        jsonb_agg(
          jsonb_build_object(
            'collection_id', s.collection_id,
            'date', (ac.created_at AT TIME ZONE 'Africa/Kampala')::date,
            'channel', ac.collection_channel
          )
          ORDER BY ac.created_at
        ) AS settled_by
      FROM public.tops_instalment_settlements s
      JOIN public.agent_collections ac ON ac.id = s.collection_id
      WHERE s.released_at IS NULL
      GROUP BY s.instalment_id
    ) sb ON sb.instalment_id = i.id
    WHERE i.rent_request_id = p_rent_request_id
    ORDER BY i.seq
  LOOP
    v_running := GREATEST(0, v_running + (v_row.amount_ugx - v_row.settled_ugx));

    seq := v_row.seq;
    due_date := v_row.due_date;
    amount_ugx := v_row.amount_ugx;
    settled_ugx := v_row.settled_ugx;
    outstanding_ugx := v_row.amount_ugx - v_row.settled_ugx;
    running_arrears_ugx := v_running;
    settled_by := v_row.settled_by;
    never_billed := COALESCE(v_first_pin IS NOT NULL AND v_row.due_date < v_first_pin, false);

    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_plan_schedule_ledger(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_plan_schedule_ledger(uuid) TO authenticated;

COMMENT ON FUNCTION public.tops_plan_schedule_ledger(uuid) IS
'Read RPC for the Tenant Ops Workspace: one row per instalment for a plan, with which collections settled it (settled_by) and whether its due date precedes the plan''s first pinned day in agent_expected_day_plans (never_billed). Gated by an internal has_role check (tenant_ops/operations/coo/cfo/ceo/super_admin) — EXECUTE is granted to authenticated, but an unauthorized caller gets an exception.';
