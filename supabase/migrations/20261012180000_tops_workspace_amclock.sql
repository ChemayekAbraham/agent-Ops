-- Tenant Operations Workspace on the shared payout clock (read-only, additive).
--
-- The Workspace used to start every Rent Plan from tops_plan_clock, which uses the FIRST
-- landlord_payouts.otp_verified_at, ignores payout status, starts the same day, and falls back
-- to funded_at. Agent Monitoring starts a Rent Plan the Kampala day AFTER the LAST landlord
-- payout whose status is awaiting_agent_receipt or completed (am_plan_clock). This migration adds
-- a parallel set of functions with the suffix _amclock that take the start from the SAME rule.
--
-- Nothing existing is edited: tops_plan_clock, tops_resolve_plan_clock, tops_plan_instalments,
-- every tops_* function, view, trigger and policy stay exactly as they are. Rollback:
-- supabase/rollbacks/20261012180000_tops_workspace_amclock.rollback.sql drops every *_amclock object.
--
-- Rules
--   * Start = am_plan_clock (outstanding_balance keeps its stored start).
--   * 'override' rows in tops_plan_clock win and are used exactly as set by hand (their own start,
--     cadence and instalment dates), the 2 hand-set rows included.
--   * Plans whose bucket is tenant_paying_no_landlord or awaiting_landlord have no clock, owe
--     nothing, never appear in arrears or due totals, and are counted separately
--     (tops_landlord_not_paid_summary_amclock).
--   * Cadence: the saved clock's confirmed cadence when it has one, otherwise the plan's own
--     repayment_frequency (weekly, else daily), the same rule Agent Monitoring applies. This lets
--     plans whose cadence was never confirmed (713 of 719 live clock rows) count the same way.
--   * Money: paid = non-reversed agent_collections + tenant repayments that do not mirror a
--     collection (same plan, same amount, within 5 minutes), counted up to the as-at day, settled
--     first-in-first-out against the instalments, exactly as am_plan_arrears does, so due and arrears
--     equal am_plan_arrears for the same plan and day.
--
-- Part 1: shared helpers and the functions that cannot be derived by rewriting an existing one.

-- 1. The am clock without the Agent Monitoring role gate (internal; the _amclock functions carry
--    their own Workspace role checks). Same logic as am_plan_clock; supabase/tests/tops_amclock_parity.sql
--    proves the two agree for every Rent Plan.
CREATE OR REPLACE FUNCTION public._am_plan_clock_core(p_rent_request_ids uuid[])
RETURNS TABLE (
  rent_request_id               uuid,
  bucket                        text,
  landlord_paid_count           integer,
  landlord_paid_total           numeric,
  landlord_paid_dates_estimated integer,
  first_landlord_paid_on        date,
  last_landlord_paid_on         date,
  clock_start                   date,
  clock_end                     date,
  current_start                 date,
  shift_days                    integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH ids AS (
    SELECT DISTINCT u.id FROM unnest(p_rent_request_ids) AS u(id)
  ),
  pay AS (
    SELECT d.rid,
           count(*)::int                                  AS n,
           COALESCE(sum(d.amount), 0)                     AS total,
           count(*) FILTER (WHERE d.estimated)::int       AS est,
           min(d.day)                                     AS first_on,
           max(d.day)                                     AS last_on
      FROM (
        SELECT lp.rent_request_id AS rid,
               lp.amount,
               (lp.finops_disbursed_at IS NULL AND lp.disbursed_at IS NULL) AS estimated,
               (COALESCE(lp.finops_disbursed_at, lp.disbursed_at, lp.otp_verified_at)
                  AT TIME ZONE 'Africa/Kampala')::date AS day
          FROM public.landlord_payouts lp
         WHERE lp.rent_request_id IN (SELECT id FROM ids)
           AND lp.status IN ('awaiting_agent_receipt', 'completed')
      ) d
     GROUP BY d.rid
  )
  SELECT rr.id,
         CASE
           WHEN rr.registration_type = 'outstanding_balance' THEN 'outstanding_balance'
           WHEN COALESCE(p.n, 0) > 0                         THEN 'counting'
           WHEN COALESCE(rr.amount_repaid, 0) > 0
                OR EXISTS (SELECT 1 FROM public.agent_collections ac
                            WHERE ac.rent_request_id = rr.id AND ac.reversed_at IS NULL)
                                                             THEN 'tenant_paying_no_landlord'
           ELSE 'awaiting_landlord'
         END,
         COALESCE(p.n, 0),
         COALESCE(p.total, 0),
         COALESCE(p.est, 0),
         p.first_on,
         p.last_on,
         c.cs,
         CASE WHEN c.cs IS NOT NULL AND rr.duration_days IS NOT NULL
              THEN c.cs + rr.duration_days - 1 END,
         rr.repayment_starts_on,
         CASE WHEN c.cs IS NOT NULL AND rr.repayment_starts_on IS NOT NULL
              THEN c.cs - rr.repayment_starts_on END
    FROM ids
    JOIN public.rent_requests rr ON rr.id = ids.id
    LEFT JOIN pay p ON p.rid = rr.id
    CROSS JOIN LATERAL (
      SELECT CASE
               WHEN rr.registration_type = 'outstanding_balance' THEN rr.repayment_starts_on
               WHEN COALESCE(p.n, 0) > 0                         THEN p.last_on + 1
               ELSE NULL::date
             END AS cs
    ) c;
$function$;

-- 2. The saved clock, re-read from the shared clock. Same columns as tops_plan_clock.
--    p_ids NULL = the live Rent Plans (funded, disbursed, repaying).
CREATE OR REPLACE FUNCTION public._tops_plan_clock_amclock_for(p_ids uuid[])
RETURNS SETOF public.tops_plan_clock
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH scope AS (
    SELECT COALESCE(p_ids, ARRAY(
      SELECT r.id FROM public.rent_requests r WHERE r.status IN ('funded', 'disbursed', 'repaying')
    )) AS ids
  ),
  am AS (
    SELECT * FROM public._am_plan_clock_core((SELECT ids FROM scope))
  )
  -- hand-set override rows win, exactly as saved
  SELECT t.*
    FROM public.tops_plan_clock t
   WHERE t.clock_source = 'override'
     AND t.rent_request_id IN (SELECT unnest(sc.ids) FROM scope sc)
  UNION ALL
  SELECT a.rent_request_id,
         a.clock_start,
         'landlord_receipt'::text,
         CASE WHEN t.cadence IN ('daily', 'weekly') THEN t.cadence
              WHEN lower(COALESCE(rr.repayment_frequency, 'daily')) = 'weekly' THEN 'weekly'
              ELSE 'daily' END,
         'explicit'::text,
         CASE WHEN (CASE WHEN t.cadence IN ('daily', 'weekly') THEN t.cadence
                         WHEN lower(COALESCE(rr.repayment_frequency, 'daily')) = 'weekly' THEN 'weekly'
                         ELSE 'daily' END) = 'weekly'
              THEN EXTRACT(DOW FROM a.clock_start)::smallint END,
         NULL::text,
         NULL::uuid,
         COALESCE(t.created_at, now()),
         COALESCE(t.updated_at, now())
    FROM am a
    JOIN public.rent_requests rr ON rr.id = a.rent_request_id
    LEFT JOIN public.tops_plan_clock t ON t.rent_request_id = a.rent_request_id
   WHERE a.bucket IN ('counting', 'outstanding_balance')
     AND a.clock_start IS NOT NULL
     AND t.clock_source IS DISTINCT FROM 'override';
$function$;

-- The Workspace's saved clock, all Rent Plans (any status) that have a counted landlord payout.
CREATE OR REPLACE FUNCTION public.tops_plan_clock_amclock()
RETURNS SETOF public.tops_plan_clock
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT * FROM public._tops_plan_clock_amclock_for(ARRAY(SELECT r.id FROM public.rent_requests r));
$function$;

-- 3. The instalment schedule for the counted plans, with first-in-first-out settlement from
--    the same payments Agent Monitoring counts. One row per instalment.
CREATE OR REPLACE FUNCTION public._tops_am_schedule(p_ids uuid[], p_as_at date)
RETURNS TABLE (
  rent_request_id uuid,
  seq             integer,
  instalment_id   uuid,
  due_date        date,
  amount_ugx      numeric,
  cum_before      numeric,
  paid_ugx        numeric,
  settled_ugx     numeric,
  outstanding_ugx numeric,
  never_billed    boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH plan AS (
    SELECT c.rent_request_id, c.clock_start, c.cadence, c.clock_source,
           COALESCE(rr.daily_repayment, 0) AS d, COALESCE(rr.total_repayment, 0) AS tot
      FROM public._tops_plan_clock_amclock_for(p_ids) c
      JOIN public.rent_requests rr ON rr.id = c.rent_request_id
     WHERE c.cadence IN ('daily', 'weekly')
       AND COALESCE(rr.daily_repayment, 0) > 0 AND COALESCE(rr.total_repayment, 0) > 0
  ),
  shaped AS (
    SELECT p.*, CASE WHEN p.cadence = 'weekly' THEN p.d * 7 ELSE p.d END AS period FROM plan p
  ),
  counted AS (
    SELECT s.*, ceil(s.tot / s.period)::int AS n FROM shaped s
  ),
  inst AS (
    SELECT s.rent_request_id, g AS seq,
           -- override rows keep the saved convention (first instalment one period after the start);
           -- everything else starts ON the clock start, as Agent Monitoring does.
           s.clock_start + CASE WHEN s.clock_source = 'override'
                                THEN (CASE WHEN s.cadence = 'weekly' THEN 7 * g ELSE g END)
                                ELSE (CASE WHEN s.cadence = 'weekly' THEN 7 * (g - 1) ELSE g - 1 END) END AS due_date,
           LEAST(s.period * g, s.tot) - LEAST(s.period * (g - 1), s.tot) AS amount,
           LEAST(s.period * (g - 1), s.tot) AS cum_before
      FROM counted s
      CROSS JOIN LATERAL generate_series(1, s.n) g
  ),
  paid AS (
    SELECT x.rent_request_id, SUM(x.amount) AS paid
      FROM (
        SELECT ac.rent_request_id, COALESCE(ac.amount, 0) AS amount
          FROM public.agent_collections ac
         WHERE ac.reversed_at IS NULL
           AND ac.rent_request_id IN (SELECT pl.rent_request_id FROM plan pl)
           AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date <= p_as_at
        UNION ALL
        SELECT rp.rent_request_id, COALESCE(rp.amount, 0)
          FROM public.repayments rp
         WHERE rp.rent_request_id IN (SELECT pl.rent_request_id FROM plan pl)
           AND (rp.created_at AT TIME ZONE 'Africa/Kampala')::date <= p_as_at
           AND NOT EXISTS (
             SELECT 1 FROM public.agent_collections ac2
              WHERE ac2.rent_request_id = rp.rent_request_id
                AND ac2.reversed_at IS NULL
                AND COALESCE(ac2.amount, 0) = COALESCE(rp.amount, 0)
                AND abs(extract(epoch FROM (ac2.created_at - rp.created_at))) < 300)
      ) x
     GROUP BY x.rent_request_id
  ),
  first_pin AS (
    SELECT e.rent_request_id, MIN(e.day) AS first_day
      FROM public.agent_expected_day_plans e
     WHERE e.rent_request_id IN (SELECT pl.rent_request_id FROM plan pl)
     GROUP BY e.rent_request_id
  )
  SELECT i.rent_request_id,
         i.seq,
         md5(i.rent_request_id::text || ':' || i.seq::text)::uuid,
         i.due_date,
         i.amount,
         i.cum_before,
         COALESCE(pd.paid, 0),
         -- first-in-first-out; a negative net payment (a refund or reversal posted as a repayment)
         -- lands on the first instalment so the total owed equals expected - paid, as in am_plan_arrears
         CASE WHEN i.seq = 1 THEN LEAST(i.amount, COALESCE(pd.paid, 0))
              ELSE LEAST(i.amount, GREATEST(0, COALESCE(pd.paid, 0) - i.cum_before)) END,
         i.amount - CASE WHEN i.seq = 1 THEN LEAST(i.amount, COALESCE(pd.paid, 0))
                         ELSE LEAST(i.amount, GREATEST(0, COALESCE(pd.paid, 0) - i.cum_before)) END,
         COALESCE(fp.first_day IS NOT NULL AND i.due_date < fp.first_day, false)
    FROM inst i
    LEFT JOIN paid pd ON pd.rent_request_id = i.rent_request_id
    LEFT JOIN first_pin fp ON fp.rent_request_id = i.rent_request_id
   WHERE i.amount > 0;
$function$;

-- 4. Replacement for tops_open_instalments_asof, same columns.
CREATE OR REPLACE FUNCTION public.tops_open_instalments_asof_amclock(p_as_at date)
RETURNS TABLE(rent_request_id uuid, instalment_id uuid, due_date date, amount_ugx numeric,
              settled_ugx numeric, outstanding_ugx numeric, never_billed boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT s.rent_request_id, s.instalment_id, s.due_date, s.amount_ugx, s.settled_ugx,
         s.outstanding_ugx, s.never_billed
    FROM public._tops_am_schedule(NULL, p_as_at) s
   WHERE s.due_date <= p_as_at AND s.outstanding_ugx > 0;
$function$;

-- 5. Replacement for tops_plan_position_internal (same columns), one Rent Plan.
CREATE OR REPLACE FUNCTION public.tops_plan_position_internal_amclock(p_rent_request_id uuid, p_as_at date DEFAULT NULL::date)
RETURNS TABLE(rent_request_id uuid, cadence text, cadence_source text, clock_start date, clock_source text,
              term_end_date date, expected_to_date_ugx numeric, paid_to_date_ugx numeric, position_ugx numeric,
              periods_due integer, days_past_due integer, days_behind integer, days_ahead integer,
              outstanding_ugx numeric, catch_up_daily_ugx numeric, term_expired boolean, as_at date, basis text)
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
  v_daily_repayment numeric;
  v_total_repayment numeric;
  v_term_end_date date;
  v_expected numeric;
  v_paid numeric;
  v_paid_raw numeric;
  v_position numeric;
  v_periods_due integer;
  v_oldest_unsettled_due date;
  v_days_past_due integer;
  v_deficit numeric;
  v_surplus numeric;
  v_days_behind integer;
  v_days_ahead integer;
  v_outstanding numeric;
  v_catch_up numeric;
  v_term_expired boolean;
BEGIN
  PERFORM 1 FROM public.rent_requests rr0 WHERE rr0.id = p_rent_request_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT rr.duration_days, rr.daily_repayment, rr.total_repayment
    INTO v_duration_days, v_daily_repayment, v_total_repayment
    FROM public.rent_requests rr
   WHERE rr.id = p_rent_request_id;

  SELECT c.clock_start, c.clock_source, c.cadence, c.cadence_source
    INTO v_clock_start, v_clock_source, v_cadence, v_cadence_source
    FROM public._tops_plan_clock_amclock_for(ARRAY[p_rent_request_id]) c;

  -- No counted landlord payout yet: the Rent Plan owes nothing and has no clock. Never a number.
  IF NOT FOUND OR v_cadence IS NULL OR v_clock_start IS NULL THEN
    RETURN QUERY SELECT
      p_rent_request_id, 'unknown'::text, 'unknown'::text, NULL::date, NULL::text,
      NULL::date, NULL::numeric, NULL::numeric, NULL::numeric, NULL::integer,
      NULL::integer, NULL::integer, NULL::integer, NULL::numeric, NULL::numeric,
      NULL::boolean, v_as_at, 'kampala;landlord_not_paid;amclock'::text;
    RETURN;
  END IF;

  v_term_end_date := v_clock_start + (v_duration_days - 1);
  v_term_expired := v_term_end_date < v_as_at;

  SELECT COALESCE(SUM(s.amount_ugx) FILTER (WHERE s.due_date <= v_as_at), 0),
         MAX(s.paid_ugx),
         count(*) FILTER (WHERE s.due_date <= v_as_at AND s.outstanding_ugx > 0),
         MIN(s.due_date) FILTER (WHERE s.due_date <= v_as_at AND s.outstanding_ugx > 0)
    INTO v_expected, v_paid_raw, v_periods_due, v_oldest_unsettled_due
    FROM public._tops_am_schedule(ARRAY[p_rent_request_id], v_as_at) s;

  v_expected := LEAST(COALESCE(v_expected, 0), v_total_repayment);
  v_paid := LEAST(COALESCE(v_paid_raw, 0), v_total_repayment);
  v_position := v_paid - v_expected;

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
    v_term_expired, v_as_at, 'kampala;capped;reversals_excluded;amclock'::text;
END;
$function$;

-- 6. Replacements for the schedule ledger (same columns) and its row count.
CREATE OR REPLACE FUNCTION public.tops_plan_schedule_ledger_amclock(p_rent_request_id uuid, p_limit integer DEFAULT NULL::integer, p_offset integer DEFAULT 0)
RETURNS TABLE(seq integer, due_date date, amount_ugx numeric, settled_ugx numeric, outstanding_ugx numeric,
              running_arrears_ugx numeric, settled_by jsonb, never_billed boolean)
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

  RETURN QUERY
  WITH sch AS (
    SELECT s.* FROM public._tops_am_schedule(ARRAY[p_rent_request_id], 'infinity'::date) s
  ),
  pays AS (
    SELECT x.collection_id, x.paid_at, x.channel, x.amount,
           SUM(x.amount) OVER (ORDER BY x.paid_at, x.collection_id NULLS LAST) - x.amount AS before_amt
      FROM (
        SELECT ac.id AS collection_id, ac.created_at AS paid_at, ac.collection_channel::text AS channel, COALESCE(ac.amount, 0) AS amount
          FROM public.agent_collections ac
         WHERE ac.rent_request_id = p_rent_request_id AND ac.reversed_at IS NULL
        UNION ALL
        SELECT NULL::uuid, rp.created_at, 'tenant_self_payment'::text, COALESCE(rp.amount, 0)
          FROM public.repayments rp
         WHERE rp.rent_request_id = p_rent_request_id
           AND NOT EXISTS (
             SELECT 1 FROM public.agent_collections ac2
              WHERE ac2.rent_request_id = rp.rent_request_id AND ac2.reversed_at IS NULL
                AND COALESCE(ac2.amount, 0) = COALESCE(rp.amount, 0)
                AND abs(extract(epoch FROM (ac2.created_at - rp.created_at))) < 300)
      ) x
  ),
  by_inst AS (
    SELECT s.seq,
           COALESCE(jsonb_agg(jsonb_build_object(
             'collection_id', p.collection_id,
             'date', (p.paid_at AT TIME ZONE 'Africa/Kampala')::date,
             'channel', p.channel) ORDER BY p.paid_at) FILTER (WHERE p.amount > 0), '[]'::jsonb) AS settled_by
      FROM sch s
      LEFT JOIN pays p
        ON p.before_amt < s.cum_before + s.amount_ugx
       AND p.before_amt + p.amount > s.cum_before
       AND s.settled_ugx > 0
     GROUP BY s.seq
  ),
  ranked AS (
    SELECT s.seq, s.due_date, s.amount_ugx, s.settled_ugx, s.outstanding_ugx,
           SUM(s.outstanding_ugx) OVER (ORDER BY s.seq) AS running,
           b.settled_by, s.never_billed,
           row_number() OVER (ORDER BY s.seq) - 1 AS idx
      FROM sch s JOIN by_inst b ON b.seq = s.seq
  )
  SELECT r.seq, r.due_date, r.amount_ugx, r.settled_ugx, r.outstanding_ugx, r.running, r.settled_by, r.never_billed
    FROM ranked r
   WHERE p_limit IS NULL OR (r.idx >= p_offset AND r.idx < p_offset + p_limit)
   ORDER BY r.seq;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tops_plan_schedule_ledger_count_amclock(p_rent_request_id uuid)
RETURNS integer
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

  RETURN (SELECT count(*)::integer FROM public._tops_am_schedule(ARRAY[p_rent_request_id], 'infinity'::date));
END;
$function$;

-- 7. Replacement for tops_pay_behaviour_scope: same columns and filters, but only Rent Plans on
--    the shared clock, and sc_start is that clock's start.
CREATE OR REPLACE FUNCTION public.tops_pay_behaviour_scope_amclock(
  p_agent_id uuid DEFAULT NULL::uuid, p_region text DEFAULT NULL::text,
  p_district text DEFAULT NULL::text, p_cadence text DEFAULT NULL::text)
RETURNS TABLE(sc_rr uuid, sc_tenant uuid, sc_agent uuid, sc_cadence text, sc_rent numeric, sc_start date, sc_status text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  IF p_region IS NULL AND p_district IS NULL THEN
    RETURN QUERY
    SELECT rr.id, rr.tenant_id, rr.agent_id, rr.repayment_frequency, rr.rent_amount, c.clock_start, rr.status
      FROM public.rent_requests rr
      JOIN public.tops_plan_clock_amclock() c ON c.rent_request_id = rr.id
     WHERE rr.tenant_id IS NOT NULL
       AND (p_agent_id IS NULL OR rr.agent_id = p_agent_id)
       AND (p_cadence IS NULL OR rr.repayment_frequency = p_cadence);
  ELSE
    RETURN QUERY
    SELECT rr.id, rr.tenant_id, rr.agent_id, rr.repayment_frequency, rr.rent_amount, c.clock_start, rr.status
      FROM public.rent_requests rr
      JOIN public.tops_plan_clock_amclock() c ON c.rent_request_id = rr.id
      JOIN public.v_tlb_tenant_base tb ON tb.tenant_id = rr.tenant_id
     WHERE rr.tenant_id IS NOT NULL
       AND (p_agent_id IS NULL OR rr.agent_id = p_agent_id)
       AND (p_region IS NULL OR tb.region = p_region)
       AND (p_district IS NULL OR tb.district_name = p_district)
       AND (p_cadence IS NULL OR rr.repayment_frequency = p_cadence);
  END IF;
END;
$function$;

-- 8. How many live Rent Plans are not counted because the landlord has not been paid yet.
CREATE OR REPLACE FUNCTION public.tops_landlord_not_paid_summary_amclock()
RETURNS TABLE(tenant_paying_no_landlord integer, awaiting_landlord integer, total_plans integer, as_of date)
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

  RETURN QUERY
  SELECT (count(*) FILTER (WHERE k.bucket = 'tenant_paying_no_landlord'))::integer,
         (count(*) FILTER (WHERE k.bucket = 'awaiting_landlord'))::integer,
         (count(*) FILTER (WHERE k.bucket IN ('tenant_paying_no_landlord', 'awaiting_landlord')))::integer,
         (now() AT TIME ZONE 'Africa/Kampala')::date
    FROM public._am_plan_clock_core(ARRAY(
           SELECT r.id FROM public.rent_requests r WHERE r.status IN ('funded', 'disbursed', 'repaying'))) k
   -- a plan with a hand-set override clock IS counted (the override wins), so it is not "not counted"
   WHERE NOT EXISTS (SELECT 1 FROM public.tops_plan_clock o
                      WHERE o.rent_request_id = k.rent_request_id AND o.clock_source = 'override');
END;
$function$;

-- 9. The remaining _amclock functions are generated from the LIVE definition of the function they
--    replace, so each has exactly the same arguments, return shape, role check and body. Only
--    three things change: the function name gets the suffix _amclock; every call to a function
--    that has an _amclock replacement (above or in this list) points at that replacement; and a
--    direct read of the saved clock table tops_plan_clock reads tops_plan_clock_amclock() instead.
--    The block stops with an error if any reference to the old start (the saved clock, the saved
--    instalments, the saved settlements or an un-replaced function) is left in a generated body.
DO $gen$
DECLARE
  -- generated from the live definitions (each has exactly one overload)
  v_clone text[] := ARRAY[
    'tops_agent_arrears_book', 'tops_agent_float_adequacy', 'tops_agent_float_adequacy_internal',
    'tops_area_book', 'tops_arrears_ageing', 'tops_calling_money_at_risk', 'tops_collections_movement',
    'tops_never_billed', 'tops_never_billed_summary', 'tops_overnight_changes',
    'tops_pay_behaviour_flags', 'tops_pay_behaviour_payments', 'tops_pay_behaviour_payments_capped',
    'tops_pay_behaviour_plans_capped',
    'tops_payment_behaviour_by_v2', 'tops_payment_behaviour_overview_v2', 'tops_payment_behaviour_summary_v2',
    'tops_payment_behaviour_timing_v2', 'tops_payment_behaviour_trend_v2', 'tops_payment_behaviour_watchlist_v2',
    'tops_pipeline_queue', 'tops_pipeline_queue_gap_counts', 'tops_plan_pipeline_stages',
    'tops_plan_position', 'tops_portfolio_quality',
    'tops_shortfall_breakdown_v2', 'tops_shortfall_detail_v3', 'tops_shortfall_lines', 'tops_shortfall_lines_v2'
  ];
  -- written by hand above; calls to these are redirected too
  v_hand text[] := ARRAY['tops_open_instalments_asof', 'tops_plan_position_internal', 'tops_pay_behaviour_scope'];
  v_all text[];
  v_name text;
  v_dep text;
  v_oid oid;
  v_n int;
  v_def text;
  v_new text;
  v_args text;
  v_made text[] := '{}';
BEGIN
  v_all := v_clone || v_hand;

  FOREACH v_name IN ARRAY v_clone LOOP
    SELECT count(*), min(p.oid) INTO v_n, v_oid
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v_name;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'expected exactly one live function named %, found %', v_name, v_n;
    END IF;

    v_def := pg_get_functiondef(v_oid);
    v_new := v_def;

    -- calls (and this function's own CREATE line) -> the _amclock replacement
    FOREACH v_dep IN ARRAY v_all LOOP
      v_new := regexp_replace(v_new, '(public\.)?\m' || v_dep || '\M(?=\s*\()', 'public.' || v_dep || '_amclock', 'g');
    END LOOP;

    -- direct reads of the saved clock table -> the shared clock
    IF v_name = 'tops_plan_pipeline_stages' THEN
      v_new := regexp_replace(v_new, 'public\.tops_plan_clock\M(?!_)', 'public._tops_plan_clock_amclock_for(ARRAY[p_rent_request_id])', 'g');
    ELSE
      v_new := regexp_replace(v_new, 'public\.tops_plan_clock\M(?!_)', 'public.tops_plan_clock_amclock()', 'g');
    END IF;

    -- nothing that carries the old start may be left behind
    IF v_new ~ '\m(tops_plan_instalments|tops_instalment_settlements|tops_resolve_plan_clock|tops_build_plan_instalments)\M'
       OR v_new ~ '\mtops_plan_clock\M(?!_amclock)'
       OR v_new ~ ('\m(' || array_to_string(v_hand, '|') || ')\M') THEN
      RAISE EXCEPTION 'generated body of % still reads the old plan start', v_name;
    END IF;
    IF v_new !~ ('FUNCTION public\.' || v_name || '_amclock\(') THEN
      RAISE EXCEPTION 'generated header of % was not renamed', v_name;
    END IF;

    EXECUTE v_new;

    v_args := pg_get_function_identity_arguments(v_oid);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon, service_role', v_name || '_amclock', v_args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO authenticated', v_name || '_amclock', v_args);
    v_made := v_made || (v_name || '_amclock');
  END LOOP;

  RAISE NOTICE 'tops_workspace_amclock: generated % functions: %', cardinality(v_made), array_to_string(v_made, ', ');
END
$gen$;

-- 10. Grants for the hand-written functions. The internal helpers are not callable from the API.
REVOKE ALL ON FUNCTION public._am_plan_clock_core(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._tops_plan_clock_amclock_for(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._tops_am_schedule(uuid[], date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tops_plan_clock_amclock() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tops_open_instalments_asof_amclock(date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tops_plan_position_internal_amclock(uuid, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tops_pay_behaviour_scope_amclock(uuid, text, text, text) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.tops_plan_schedule_ledger_amclock(uuid, integer, integer) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.tops_plan_schedule_ledger_count_amclock(uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.tops_landlord_not_paid_summary_amclock() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.tops_plan_schedule_ledger_amclock(uuid, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tops_plan_schedule_ledger_count_amclock(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tops_landlord_not_paid_summary_amclock() TO authenticated;
