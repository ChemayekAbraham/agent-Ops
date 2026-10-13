-- Agent Monitoring: one fast RPC for the two uncovered-plan lists, and a daily check that the three
-- pages (Agent Monitoring, Tenant Ops Workspace, Weekly Performance) still agree.
--
-- Read-only figures only. No money, status or trigger changes; nothing existing is edited (not
-- am_plan_clock, am_plan_arrears, am_plan_positions, tops_plan_clock, any view, trigger or policy, the
-- agent dashboard or Priority Collections). Everything below is new.
--
--   1. am_uncovered_plans(p_as_at, p_limit, p_offset): the live Rent Plans the payout clock does not cover
--      (tenant_paying_no_landlord, awaiting_landlord) with tenant, agent, amounts, days and the landlord
--      payout state, in one call. SECURITY DEFINER behind _am_staff_ok(), so a staff role that cannot
--      read float allocations directly still sees the part-paid amount.
--   2. _am_plan_arrears_core: am_plan_arrears without the staff gate, for the daily check (no signed-in user).
--   3. am_clock_drift_runs / am_clock_drift_daily: append-only record of where am_plan_clock disagrees with
--      what the Workspace and Weekly Performance used, with the UGX difference in due and arrears.
--   4. am_detect_clock_drift(): run daily at 06:00 Kampala; emits a system_event when plans differ.
--   5. get_am_clock_drift_status(): the small "Pages agree / N plans differ" line for staff.

-- 1. The two uncovered lists --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.am_uncovered_plans(
  p_as_at date DEFAULT NULL,
  p_limit integer DEFAULT 500,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  rent_request_id         uuid,
  bucket                  text,
  tenant_id               uuid,
  tenant_name             text,
  tenant_phone            text,
  agent_id                uuid,
  agent_name              text,
  funded_amount           numeric,
  total_repayment         numeric,
  repaid                  numeric,
  still_owed              numeric,
  funded_on               date,
  days_since_funding      integer,
  payout_kind             text,
  payout_paid_amount      numeric,
  payout_allocated_amount numeric,
  pipeline_status         text,
  total_rows              bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
#variable_conflict use_column
DECLARE
  v_as_at date := COALESCE(p_as_at, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 1000);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF auth.uid() IS NULL OR NOT public._am_staff_ok() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH live AS (
    SELECT r.id FROM public.rent_requests r WHERE r.status IN ('funded', 'disbursed', 'repaying')
  ),
  clk AS (
    SELECT c.rent_request_id, c.bucket
      FROM public._am_plan_clock_core(ARRAY(SELECT l.id FROM live l)) c
     WHERE c.bucket IN ('tenant_paying_no_landlord', 'awaiting_landlord')
  ),
  po AS (
    SELECT lp.rent_request_id AS rid,
           count(*)::int AS n,
           bool_or(lp.status IN ('otp_verified', 'pending_finops_disbursement', 'pending_merchant_payout', 'disbursing', 'escalated')) AS pending,
           bool_and(lp.status = 'failed') AS all_failed,
           bool_or(lp.status IN ('awaiting_agent_receipt', 'completed')) AS recorded
      FROM public.landlord_payouts lp
     WHERE lp.rent_request_id IN (SELECT k.rent_request_id FROM clk k)
     GROUP BY lp.rent_request_id
  ),
  al AS (
    SELECT a.rent_request_id AS rid,
           COALESCE(sum(a.paid_out_amount) FILTER (WHERE a.status <> 'cancelled'), 0) AS paid,
           COALESCE(sum(a.allocated_amount) FILTER (WHERE a.status <> 'cancelled'), 0) AS allocated,
           bool_or(a.status = 'fully_paid' AND a.status <> 'cancelled') AS has_full
      FROM public.agent_landlord_float_allocations a
     WHERE a.rent_request_id IN (SELECT k.rent_request_id FROM clk k)
     GROUP BY a.rent_request_id
  ),
  rows AS (
    SELECT rr.id AS rid,
           k.bucket AS bkt,
           rr.tenant_id AS tid,
           tp.full_name AS tname,
           tp.phone AS tphone,
           rr.agent_id AS aid,
           ap.full_name AS aname,
           COALESCE(rr.rent_amount, 0) AS funded,
           COALESCE(rr.total_repayment, 0) AS total,
           COALESCE(rr.amount_repaid, 0) AS repaid,
           GREATEST(0, COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0)) AS owed,
           (COALESCE(rr.funded_at, rr.disbursed_at, rr.created_at) AT TIME ZONE 'Africa/Kampala')::date AS funded_day,
           CASE
             WHEN COALESCE(al.paid, 0) > 0 THEN
               CASE WHEN al.has_full AND al.paid >= al.allocated AND NOT COALESCE(po.recorded, false)
                    THEN 'paid_unrecorded' ELSE 'part_paid' END
             WHEN COALESCE(po.pending, false) THEN 'pending'
             WHEN COALESCE(po.n, 0) > 0 AND COALESCE(po.all_failed, false) THEN 'failed'
             ELSE 'none'
           END AS kind,
           COALESCE(al.paid, 0) AS paid_amt,
           COALESCE(al.allocated, 0) AS alloc_amt,
           rr.status AS pstatus
      FROM clk k
      JOIN public.rent_requests rr ON rr.id = k.rent_request_id
      LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
      LEFT JOIN public.profiles ap ON ap.id = rr.agent_id
      LEFT JOIN po ON po.rid = rr.id
      LEFT JOIN al ON al.rid = rr.id
  )
  SELECT x.rid, x.bkt, x.tid, x.tname, x.tphone, x.aid, x.aname, x.funded, x.total, x.repaid, x.owed,
         x.funded_day,
         GREATEST(0, v_as_at - x.funded_day)::int,
         x.kind, x.paid_amt, x.alloc_amt, x.pstatus,
         count(*) OVER ()
    FROM rows x
   ORDER BY x.rid
   LIMIT v_limit OFFSET v_offset;
END;
$function$;

-- 2. am_plan_arrears without the staff gate (internal; the daily check runs with no signed-in user) -------
CREATE OR REPLACE FUNCTION public._am_plan_arrears_core(p_rent_request_ids uuid[], p_as_at date)
RETURNS TABLE (
  rent_request_id uuid,
  bucket          text,
  cadence         text,
  unit            text,
  clock_start     date,
  expected_to_date numeric,
  paid_to_date    numeric,
  arrears         numeric,
  days_behind     integer,
  days_ahead      integer,
  periods_behind  integer,
  periods_ahead   integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH clk AS (
    SELECT * FROM public._am_plan_clock_core(p_rent_request_ids)
  ),
  coll AS (
    SELECT ac.rent_request_id AS rid, COALESCE(sum(ac.amount), 0) AS paid
      FROM public.agent_collections ac
     WHERE ac.rent_request_id IN (SELECT k.rent_request_id FROM clk k)
       AND ac.reversed_at IS NULL
       AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date <= p_as_at
     GROUP BY ac.rent_request_id
  ),
  rep AS (
    SELECT rp.rent_request_id AS rid, COALESCE(sum(rp.amount), 0) AS paid
      FROM public.repayments rp
     WHERE rp.rent_request_id IN (SELECT k.rent_request_id FROM clk k)
       AND (rp.created_at AT TIME ZONE 'Africa/Kampala')::date <= p_as_at
       AND NOT EXISTS (
         SELECT 1 FROM public.agent_collections ac
          WHERE ac.rent_request_id = rp.rent_request_id
            AND ac.reversed_at IS NULL
            AND COALESCE(ac.amount, 0) = COALESCE(rp.amount, 0)
            AND abs(extract(epoch FROM (ac.created_at - rp.created_at))) < 300)
     GROUP BY rp.rent_request_id
  ),
  base AS (
    SELECT k.rent_request_id AS rid, k.bucket, k.clock_start AS cs,
           (lower(COALESCE(rr.repayment_frequency, 'daily')) = 'weekly') AS weekly,
           COALESCE(rr.total_repayment, 0) AS total,
           COALESCE(rr.daily_repayment, 0)
             * CASE WHEN lower(COALESCE(rr.repayment_frequency, 'daily')) = 'weekly' THEN 7 ELSE 1 END AS period,
           COALESCE(c.paid, 0) + COALESCE(r.paid, 0) AS paid
      FROM clk k
      JOIN public.rent_requests rr ON rr.id = k.rent_request_id
      LEFT JOIN coll c ON c.rid = k.rent_request_id
      LEFT JOIN rep  r ON r.rid = k.rent_request_id
  ),
  due AS (
    SELECT b.*,
           CASE WHEN b.cs IS NULL OR p_as_at < b.cs THEN 0
                WHEN b.weekly THEN ((p_as_at - b.cs) / 7) + 1
                ELSE (p_as_at - b.cs) + 1 END AS raw_periods,
           CASE WHEN b.period > 0 THEN ceil(b.total / b.period)::int ELSE 0 END AS total_periods
      FROM base b
  ),
  calc AS (
    SELECT d.*,
           CASE WHEN d.total_periods > 0 THEN least(d.raw_periods, d.total_periods) ELSE d.raw_periods END AS periods_due
      FROM due d
  ),
  money AS (
    SELECT c.*,
           CASE WHEN c.cs IS NULL THEN 0::numeric
                ELSE least(CASE WHEN c.total > 0 THEN c.total ELSE c.period * c.periods_due END,
                           c.period * c.periods_due) END AS expected
      FROM calc c
  )
  SELECT m.rid,
         m.bucket,
         CASE WHEN m.weekly THEN 'weekly' ELSE 'daily' END,
         CASE WHEN m.weekly THEN 'week'   ELSE 'day'   END,
         m.cs,
         m.expected,
         m.paid,
         CASE WHEN m.cs IS NULL THEN 0::numeric ELSE greatest(0, m.expected - m.paid) END,
         (CASE WHEN m.cs IS NULL OR m.period <= 0 THEN 0
               ELSE greatest(0, ceil(greatest(0, m.expected - m.paid) / m.period)::int - 1) END)
           * CASE WHEN m.weekly THEN 7 ELSE 1 END,
         (CASE WHEN m.cs IS NULL OR m.period <= 0 THEN 0
               ELSE floor(greatest(0, m.paid - m.expected) / m.period)::int END)
           * CASE WHEN m.weekly THEN 7 ELSE 1 END,
         CASE WHEN m.cs IS NULL OR m.period <= 0 THEN 0
              ELSE greatest(0, ceil(greatest(0, m.expected - m.paid) / m.period)::int - 1) END,
         CASE WHEN m.cs IS NULL OR m.period <= 0 THEN 0
              ELSE floor(greatest(0, m.paid - m.expected) / m.period)::int END
    FROM money m;
$function$;

-- 3. Append-only drift record ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.am_clock_drift_runs (
  run_id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_date               date NOT NULL,
  run_at                 timestamptz NOT NULL DEFAULT now(),
  as_at                  date NOT NULL,
  plans_checked          integer NOT NULL,
  plans_differ           integer NOT NULL,
  plans_explained        integer NOT NULL,
  due_diff_ugx           numeric NOT NULL DEFAULT 0,
  arrears_diff_ugx       numeric NOT NULL DEFAULT 0,
  event_emitted          boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS public.am_clock_drift_daily (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id                 bigint NOT NULL REFERENCES public.am_clock_drift_runs (run_id),
  run_date               date NOT NULL,
  rent_request_id        uuid NOT NULL,
  page                   text NOT NULL CHECK (page IN ('workspace', 'weekly')),
  reason                 text NOT NULL,
  explained              boolean NOT NULL DEFAULT false,
  am_bucket              text,
  am_clock_start         date,
  page_bucket            text,
  page_clock_start       date,
  am_due_ugx             numeric,
  page_due_ugx           numeric,
  due_diff_ugx           numeric,
  am_arrears_ugx         numeric,
  page_arrears_ugx       numeric,
  arrears_diff_ugx       numeric,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS am_clock_drift_daily_run_idx ON public.am_clock_drift_daily (run_id);
CREATE INDEX IF NOT EXISTS am_clock_drift_daily_plan_idx ON public.am_clock_drift_daily (rent_request_id, run_date DESC);

ALTER TABLE public.am_clock_drift_runs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.am_clock_drift_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.am_clock_drift_runs  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.am_clock_drift_daily FROM PUBLIC, anon, authenticated;

-- Append-only: no row is ever changed or removed.
CREATE OR REPLACE FUNCTION public._am_clock_drift_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$function$;
DROP TRIGGER IF EXISTS am_clock_drift_runs_append_only ON public.am_clock_drift_runs;
CREATE TRIGGER am_clock_drift_runs_append_only
  BEFORE UPDATE OR DELETE ON public.am_clock_drift_runs
  FOR EACH ROW EXECUTE FUNCTION public._am_clock_drift_append_only();
DROP TRIGGER IF EXISTS am_clock_drift_daily_append_only ON public.am_clock_drift_daily;
CREATE TRIGGER am_clock_drift_daily_append_only
  BEFORE UPDATE OR DELETE ON public.am_clock_drift_daily
  FOR EACH ROW EXECUTE FUNCTION public._am_clock_drift_append_only();
COMMENT ON TABLE public.am_clock_drift_daily IS
  'Append-only. One row per live Rent Plan per run where am_plan_clock disagrees with what the Workspace or Weekly Performance counted. explained = a hand-set override start kept by decision.';

-- 4. The check ---------------------------------------------------------------------------------------
-- Compares, for every live Rent Plan, the shared clock (am_plan_clock) with
--   workspace: the plan's start, due and arrears from the Workspace's _amclock schedule, and
--   weekly   : the plan's bucket, start and counted flag from this week's Weekly Performance.
-- A hand-set override start in tops_plan_clock is kept by decision and is recorded as explained.
CREATE OR REPLACE FUNCTION public.am_detect_clock_drift(p_as_at date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_as_at date := COALESCE(p_as_at, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_ids uuid[];
  v_ws date;
  v_we date;
  v_run bigint;
  v_checked integer;
  v_differ integer;
  v_explained integer;
  v_due numeric;
  v_arr numeric;
  v_emitted boolean := false;
BEGIN
  SELECT ARRAY(SELECT r.id FROM public.rent_requests r WHERE r.status IN ('funded', 'disbursed', 'repaying'))
    INTO v_ids;
  SELECT period_start, period_end INTO v_ws, v_we FROM public.tppo_period_bounds('week', v_as_at);

  DROP TABLE IF EXISTS pg_temp._drift;
  CREATE TEMP TABLE _drift ON COMMIT DROP AS
  WITH am AS (
    SELECT a.rent_request_id, a.bucket, a.clock_start, a.expected_to_date, a.arrears
      FROM public._am_plan_arrears_core(v_ids, v_as_at) a
  ),
  ws_clock AS (
    SELECT c.rent_request_id, c.clock_start, c.clock_source
      FROM public._tops_plan_clock_amclock_for(v_ids) c
  ),
  ws_sched AS (
    SELECT s.rent_request_id,
           COALESCE(sum(s.amount_ugx) FILTER (WHERE s.due_date <= v_as_at), 0) AS due,
           COALESCE(sum(s.outstanding_ugx) FILTER (WHERE s.due_date <= v_as_at AND s.outstanding_ugx > 0), 0) AS arrears
      FROM public._tops_am_schedule(v_ids, v_as_at) s
     GROUP BY s.rent_request_id
  ),
  ws AS (
    SELECT am.rent_request_id,
           am.bucket AS am_bucket,
           am.clock_start AS am_start,
           am.expected_to_date AS am_due,
           am.arrears AS am_arrears,
           wc.clock_start AS pg_start,
           wc.clock_source,
           (wc.rent_request_id IS NOT NULL) AS pg_has_clock,
           COALESCE(wsd.due, 0) AS pg_due,
           COALESCE(wsd.arrears, 0) AS pg_arrears
      FROM am
      LEFT JOIN ws_clock wc ON wc.rent_request_id = am.rent_request_id
      LEFT JOIN ws_sched wsd ON wsd.rent_request_id = am.rent_request_id
  ),
  ws_flags AS (
    SELECT w.*,
           (w.am_bucket IN ('counting', 'outstanding_balance')) AS am_counts,
           array_remove(ARRAY[
             CASE WHEN w.am_bucket IN ('counting', 'outstanding_balance') AND NOT w.pg_has_clock THEN 'workspace_has_no_clock' END,
             CASE WHEN w.am_bucket IN ('counting', 'outstanding_balance') AND w.pg_has_clock
                       AND w.pg_start IS DISTINCT FROM w.am_start THEN 'clock_start_differs' END,
             CASE WHEN w.am_bucket IN ('counting', 'outstanding_balance') AND abs(w.pg_due - w.am_due) > 0.5 THEN 'due_differs' END,
             CASE WHEN w.am_bucket IN ('counting', 'outstanding_balance') AND abs(w.pg_arrears - w.am_arrears) > 0.5 THEN 'arrears_differs' END,
             CASE WHEN w.am_bucket IN ('tenant_paying_no_landlord', 'awaiting_landlord')
                       AND (w.pg_has_clock OR w.pg_due > 0 OR w.pg_arrears > 0) THEN 'workspace_counts_unpaid_landlord' END
           ], NULL) AS reasons
      FROM ws w
  ),
  wk AS (
    SELECT p.rent_request_id, p.bucket AS pg_bucket, p.clock_start AS pg_start, p.counted
      FROM public._tenant_ops_weekly_amclock_plans(v_ws, v_we) p
  ),
  wk_flags AS (
    SELECT k.rent_request_id, k.pg_bucket, k.pg_start, a.bucket AS am_bucket, a.clock_start AS am_start,
           array_remove(ARRAY[
             CASE WHEN k.pg_bucket IS DISTINCT FROM a.bucket THEN 'bucket_differs' END,
             CASE WHEN k.pg_start IS DISTINCT FROM a.clock_start THEN 'clock_start_differs' END,
             CASE WHEN k.counted IS DISTINCT FROM
                       (a.bucket IN ('counting', 'outstanding_balance') AND a.clock_start IS NOT NULL
                        AND a.clock_start <= LEAST(v_we, v_as_at)) THEN 'counted_differs' END
           ], NULL) AS reasons
      FROM wk k
      JOIN am a ON a.rent_request_id = k.rent_request_id
  )
  SELECT f.rent_request_id,
         'workspace'::text AS page,
         array_to_string(f.reasons, ',') AS reason,
         (f.clock_source = 'override') AS explained,
         f.am_bucket,
         f.am_start AS am_clock_start,
         CASE WHEN f.pg_has_clock THEN 'counting' END AS page_bucket,
         f.pg_start AS page_clock_start,
         f.am_due AS am_due_ugx,
         f.pg_due AS page_due_ugx,
         f.pg_due - f.am_due AS due_diff_ugx,
         f.am_arrears AS am_arrears_ugx,
         f.pg_arrears AS page_arrears_ugx,
         f.pg_arrears - f.am_arrears AS arrears_diff_ugx
    FROM ws_flags f
   WHERE cardinality(f.reasons) > 0
  UNION ALL
  SELECT g.rent_request_id, 'weekly', array_to_string(g.reasons, ','), false,
         g.am_bucket, g.am_start, g.pg_bucket, g.pg_start,
         NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric
    FROM wk_flags g
   WHERE cardinality(g.reasons) > 0;

  v_checked := cardinality(v_ids);
  SELECT count(DISTINCT rent_request_id) FILTER (WHERE NOT explained),
         count(DISTINCT rent_request_id) FILTER (WHERE explained),
         COALESCE(sum(abs(due_diff_ugx)) FILTER (WHERE NOT explained), 0),
         COALESCE(sum(abs(arrears_diff_ugx)) FILTER (WHERE NOT explained), 0)
    INTO v_differ, v_explained, v_due, v_arr
    FROM _drift;

  INSERT INTO public.am_clock_drift_runs (run_date, as_at, plans_checked, plans_differ, plans_explained, due_diff_ugx, arrears_diff_ugx)
  VALUES (v_as_at, v_as_at, v_checked, v_differ, v_explained, v_due, v_arr)
  RETURNING run_id INTO v_run;

  INSERT INTO public.am_clock_drift_daily (
    run_id, run_date, rent_request_id, page, reason, explained, am_bucket, am_clock_start, page_bucket,
    page_clock_start, am_due_ugx, page_due_ugx, due_diff_ugx, am_arrears_ugx, page_arrears_ugx, arrears_diff_ugx)
  SELECT v_run, v_as_at, d.rent_request_id, d.page, d.reason, d.explained, d.am_bucket, d.am_clock_start,
         d.page_bucket, d.page_clock_start, d.am_due_ugx, d.page_due_ugx, d.due_diff_ugx,
         d.am_arrears_ugx, d.page_arrears_ugx, d.arrears_diff_ugx
    FROM _drift d;

  IF v_differ > 0 THEN
    INSERT INTO public.system_events (event_type, event_name, source, description, related_entity_type, metadata, payload)
    VALUES ('am_clock_drift_detected', 'am_clock_drift_detected', 'am_detect_clock_drift',
            v_differ || ' Rent Plan(s) are counted from a different start on the Workspace or Weekly Performance than on Agent Monitoring',
            'am_clock_drift_runs',
            jsonb_build_object('run_id', v_run, 'as_at', v_as_at, 'plans_differ', v_differ,
                               'due_diff_ugx', v_due, 'arrears_diff_ugx', v_arr),
            jsonb_build_object('run_id', v_run, 'plans_differ', v_differ));
    v_emitted := true;
  END IF;

  RETURN jsonb_build_object('run_id', v_run, 'as_at', v_as_at, 'plans_checked', v_checked,
                            'plans_differ', v_differ, 'plans_explained', v_explained,
                            'due_diff_ugx', v_due, 'arrears_diff_ugx', v_arr, 'event_emitted', v_emitted);
END;
$function$;

-- 5. The line staff see on Agent Monitoring ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_am_clock_drift_status()
RETURNS TABLE (
  run_date         date,
  run_at           timestamptz,
  plans_checked    integer,
  plans_differ     integer,
  plans_explained  integer,
  due_diff_ugx     numeric,
  arrears_diff_ugx numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public._am_staff_ok() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT r.run_date, r.run_at, r.plans_checked, r.plans_differ, r.plans_explained, r.due_diff_ugx, r.arrears_diff_ugx
      FROM public.am_clock_drift_runs r
     ORDER BY r.run_at DESC, r.run_id DESC
     LIMIT 1;
END;
$function$;

-- 6. Grants. The internal helpers and the check itself are not callable from the API.
REVOKE ALL ON FUNCTION public._am_plan_arrears_core(uuid[], date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._am_clock_drift_append_only() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.am_detect_clock_drift(date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.am_uncovered_plans(date, integer, integer) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.get_am_clock_drift_status() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.am_uncovered_plans(date, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_am_clock_drift_status() TO authenticated;

-- 7. Daily at 06:00 Kampala (03:00 UTC).
DO $cron$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.schedule('am-clock-drift-daily-0600-eat', '0 3 * * *', 'SELECT public.am_detect_clock_drift();');
  END IF;
END
$cron$;
