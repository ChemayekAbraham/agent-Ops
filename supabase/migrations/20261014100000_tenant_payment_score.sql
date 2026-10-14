-- Tenant payment score (0 to 100) with a label and a one-line reason.
--
-- Read-only on money and status: nothing here writes to rent_requests, agent_collections, wallets, the ledger or any
-- status. The only thing written is the append-only snapshot table below, by the nightly job.
--
-- Verified against the live schema first (14 Oct 2026): agent_collections has tenant_id, agent_id, rent_request_id,
-- amount, created_at, collection_channel and reversed_at; collection_channel is tenant_deposit_auto (tenant paid from
-- their own number), agent_float, or agent_liability_settlement (counted as neither); welile_trust_score_cache has one
-- row per user (score 0 to 100, tiers high_risk < 25, caution 25 to 39, standard 40+); _am_plan_clock_core,
-- _am_plan_arrears_core and _am_staff_ok exist.
--
-- Two kinds of tenant, scored differently:
--
-- A. HISTORY: the tenant has at least one Rent Plan the payout clock counts (am_plan_clock bucket counting or
--    outstanding_balance, so the landlord has been paid) whose clock started BEFORE the scoring day. Plans whose landlord
--    has not been paid are ignored everywhere below. Reversed collections are ignored. 100 points:
--      40  paid / owed     : paid_to_date / expected_to_date summed over those plans (am_plan_arrears), capped at 1
--      25  on-time days    : share of past due dates (daily or weekly) on which the cumulative non-reversed
--                            collections had caught up with the cumulative amount due
--      15  completed plans : completed (or fully repaid) plans / plans with a started clock
--      10  self-paid       : share of non-reversed collection money that has collection_channel = tenant_deposit_auto
--                            (agent_liability_settlement is left out of both sides)
--      10  no 20+ day gaps : 10 minus 5 for each stretch of 20 or more days without a collection (from the clock start,
--                            between collections, and up to today while the plan still owes), minimum 0
--
-- B. NEW (no history): 100 points
--      60  agent portfolio : paid / owed over the counted plans of the tenant's agent (am_plan_arrears), capped at 1
--                            (the agent is the one on the tenant's latest request, else the managing agent, else the referrer)
--                            (no measurable portfolio: 30, neutral)
--      40  trust score     : welile_trust_score_cache.score on its 0 to 100 scale (no row: 20, neutral)
--
-- Labels (cut-offs in _tps_label, one place to tune):
--      history: 80 and over proven_good, 50 to 79 average, below 50 watch
--      new    : 65 and over good_agent_pick, 30 to 64 average, below 30 watch
--      (50 and 30 are the "half of everything" point: for a new tenant the trust score is mostly small today, so
--       neutral = 30 from the agent portfolio alone)
--
-- "Today" is the Kampala date. The live function scores as at today; the nightly job (00:45 Kampala) scores as at the
-- day that has just closed, so every collection of that day is in.

-- 1. Labels -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._tps_label(p_score integer, p_basis text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE
           WHEN p_basis = 'history' THEN CASE WHEN p_score >= 80 THEN 'proven_good' WHEN p_score >= 50 THEN 'average' ELSE 'watch' END
           ELSE                          CASE WHEN p_score >= 65 THEN 'good_agent_pick' WHEN p_score >= 30 THEN 'average' ELSE 'watch' END
         END;
$function$;

-- 2. The scoring itself (internal, no gate: the live function and the nightly job wrap it) ---------------------
CREATE OR REPLACE FUNCTION public._tenant_payment_score_core(p_tenant_ids uuid[], p_as_at date)
RETURNS TABLE (
  tenant_id  uuid,
  score      integer,
  label      text,
  reason     text,
  basis      text,
  components jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH req AS (
    SELECT DISTINCT t AS tenant_id FROM unnest(p_tenant_ids) AS t WHERE t IS NOT NULL
  ),
  -- each tenant's agent, by the order the tenant list already uses: the agent on the latest request still in play,
  -- else the agent managing the tenant, else the referrer
  latest AS (
    SELECT DISTINCT ON (r.tenant_id) r.tenant_id,
           COALESCE(r.assigned_agent_id, r.agent_id, pr.managing_agent_id, pr.referrer_id) AS agent_id
      FROM public.rent_requests r
      JOIN req ON req.tenant_id = r.tenant_id
      LEFT JOIN public.profiles pr ON pr.id = r.tenant_id
     WHERE r.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent')
     ORDER BY r.tenant_id, r.created_at DESC
  ),
  tplans AS (
    SELECT r.id AS rid, r.tenant_id
      FROM public.rent_requests r
      JOIN req ON req.tenant_id = r.tenant_id
     WHERE r.status IN ('funded', 'disbursed', 'repaying', 'completed')
  ),
  aplans AS (
    SELECT r.id AS rid, COALESCE(r.assigned_agent_id, r.agent_id) AS agent_id
      FROM public.rent_requests r
     WHERE r.status IN ('funded', 'disbursed', 'repaying', 'completed')
       AND COALESCE(r.assigned_agent_id, r.agent_id) IN (SELECT l.agent_id FROM latest l WHERE l.agent_id IS NOT NULL)
  ),
  arr AS (
    SELECT * FROM public._am_plan_arrears_core(
      ARRAY(SELECT rid FROM tplans UNION SELECT rid FROM aplans), p_as_at)
  ),
  -- plans the payout clock counts (landlord paid, or a balance carried over); the rest are ignored
  pf AS (
    SELECT a.rent_request_id AS rid,
           a.clock_start AS cs,
           a.expected_to_date AS expected,
           a.paid_to_date AS paid,
           rr.status,
           COALESCE(rr.total_repayment, 0) AS total,
           COALESCE(rr.amount_repaid, 0) AS repaid,
           CASE WHEN a.cadence = 'weekly' THEN 7 ELSE 1 END AS step,
           COALESCE(rr.daily_repayment, 0) * CASE WHEN a.cadence = 'weekly' THEN 7 ELSE 1 END AS period
      FROM arr a
      JOIN public.rent_requests rr ON rr.id = a.rent_request_id
     WHERE a.bucket IN ('counting', 'outstanding_balance') AND a.clock_start IS NOT NULL
  ),
  -- the tenant's own plans with a started clock
  e AS (
    SELECT p.*, tp.tenant_id FROM pf p JOIN tplans tp ON tp.rid = p.rid WHERE p.cs < p_as_at
  ),
  -- non-reversed collections on those plans (liability settlements are neither agent nor tenant payments)
  coll AS (
    SELECT ac.rent_request_id AS rid,
           (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS day,
           ac.amount,
           ac.collection_channel AS ch
      FROM public.agent_collections ac
     WHERE ac.reversed_at IS NULL
       AND ac.collection_channel <> 'agent_liability_settlement'
       AND ac.rent_request_id IN (SELECT rid FROM e)
       AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date <= p_as_at
  ),
  -- every past due date of every plan, with what had to be paid by then
  due AS (
    SELECT e.rid, e.cs + (k - 1) * e.step AS due_date, LEAST(e.total, e.period * k) AS cum_expected
      FROM e,
           LATERAL generate_series(1, CASE WHEN e.period > 0
                                           THEN LEAST(ceil(e.total / e.period)::int, ((p_as_at - e.cs - 1) / e.step) + 1)
                                           ELSE 0 END) AS k
  ),
  daily AS (
    SELECT rid, day, sum(amount) AS amt FROM coll GROUP BY rid, day
  ),
  -- one pass per plan: collections of a day come before the due date of the same day, so the running total at a due
  -- date is everything collected up to and including that day
  timeline AS (
    SELECT rid, day, amt, NULL::numeric AS cum_expected, 0 AS ord FROM daily
    UNION ALL
    SELECT rid, due_date, 0::numeric, cum_expected, 1 FROM due
  ),
  running AS (
    SELECT rid, ord, cum_expected,
           sum(amt) OVER (PARTITION BY rid ORDER BY day, ord ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_paid
      FROM timeline
  ),
  ontime AS (
    SELECT rid,
           count(*) FILTER (WHERE ord = 1)::int AS due_n,
           count(*) FILTER (WHERE ord = 1 AND cum_paid >= cum_expected)::int AS ok_n
      FROM running
     GROUP BY rid
  ),
  pts AS (
    SELECT e.rid, e.cs AS day FROM e
    UNION ALL
    SELECT c.rid, c.day FROM (SELECT DISTINCT rid, day FROM coll) c JOIN e ON e.rid = c.rid WHERE c.day > e.cs
    UNION ALL
    SELECT e.rid, p_as_at FROM e WHERE e.status <> 'completed' AND e.total - e.repaid > 0
  ),
  gaps AS (
    SELECT rid, count(*) FILTER (WHERE day - prev_day >= 20)::int AS gap_n
      FROM (SELECT rid, day, lag(day) OVER (PARTITION BY rid ORDER BY day) AS prev_day FROM pts) q
     GROUP BY rid
  ),
  selfp AS (
    SELECT rid,
           COALESCE(sum(amount) FILTER (WHERE ch = 'tenant_deposit_auto'), 0) AS self_amt,
           COALESCE(sum(amount), 0) AS tot_amt
      FROM coll GROUP BY rid
  ),
  th AS (
    SELECT e.tenant_id,
           count(*)::int AS plans,
           count(*) FILTER (WHERE e.status = 'completed' OR (e.total > 0 AND e.repaid >= e.total))::int AS completed,
           COALESCE(sum(e.paid), 0) AS paid,
           COALESCE(sum(e.expected), 0) AS expected,
           COALESCE(sum(ot.due_n), 0)::int AS due_n,
           COALESCE(sum(ot.ok_n), 0)::int AS ok_n,
           COALESCE(sum(g.gap_n), 0)::int AS gap_n,
           COALESCE(sum(sp.self_amt), 0) AS self_amt,
           COALESCE(sum(sp.tot_amt), 0) AS tot_amt
      FROM e
      LEFT JOIN ontime ot ON ot.rid = e.rid
      LEFT JOIN gaps g ON g.rid = e.rid
      LEFT JOIN selfp sp ON sp.rid = e.rid
     GROUP BY e.tenant_id
  ),
  hist AS (
    SELECT th.*,
           round(40 * LEAST(1, CASE WHEN th.expected > 0 THEN th.paid / th.expected ELSE 1 END), 1) AS p_paid,
           round(25 * CASE WHEN th.due_n > 0 THEN th.ok_n::numeric / th.due_n ELSE 1 END, 1) AS p_ontime,
           round(15 * th.completed::numeric / th.plans, 1) AS p_done,
           round(10 * CASE WHEN th.tot_amt > 0 THEN th.self_amt / th.tot_amt ELSE 0 END, 1) AS p_self,
           GREATEST(0, 10 - 5 * th.gap_n)::numeric AS p_gap
      FROM th
  ),
  agent_port AS (
    SELECT ap.agent_id,
           COALESCE(sum(p.paid), 0) AS paid,
           COALESCE(sum(p.expected), 0) AS expected,
           count(*)::int AS plans
      FROM aplans ap
      JOIN pf p ON p.rid = ap.rid AND p.cs < p_as_at
     GROUP BY ap.agent_id
  ),
  newt AS (
    SELECT r.tenant_id,
           l.agent_id,
           pt.expected AS a_expected, pt.paid AS a_paid, pt.plans AS a_plans,
           ts.score AS trust,
           CASE WHEN pt.expected > 0 THEN round(60 * LEAST(1, pt.paid / pt.expected), 1) ELSE 30 END AS p_agent,
           CASE WHEN ts.score IS NOT NULL THEN round(40 * LEAST(100, GREATEST(0, ts.score))::numeric / 100, 1) ELSE 20 END AS p_trust
      FROM req r
      LEFT JOIN latest l ON l.tenant_id = r.tenant_id
      LEFT JOIN agent_port pt ON pt.agent_id = l.agent_id
      LEFT JOIN public.welile_trust_score_cache ts ON ts.user_id = r.tenant_id
     WHERE r.tenant_id NOT IN (SELECT h.tenant_id FROM hist h)
  ),
  scored AS (
    SELECT h.tenant_id,
           round(h.p_paid + h.p_ontime + h.p_done + h.p_self + h.p_gap)::int AS score,
           'history'::text AS basis,
           format('Paid %s%% of what was owed, %s of %s due days on time, %s of %s plan%s completed, %s',
                  round(100 * LEAST(1, CASE WHEN h.expected > 0 THEN h.paid / h.expected ELSE 1 END)),
                  h.ok_n, h.due_n, h.completed, h.plans, CASE WHEN h.plans = 1 THEN '' ELSE 's' END,
                  CASE WHEN h.gap_n = 0 THEN 'no 20+ day gap'
                       ELSE h.gap_n || ' gap' || CASE WHEN h.gap_n = 1 THEN '' ELSE 's' END || ' of 20+ days' END) AS reason,
           jsonb_build_object(
             'paid_owed',  jsonb_build_object('points', h.p_paid,   'max', 40, 'paid', h.paid, 'expected', h.expected),
             'on_time',    jsonb_build_object('points', h.p_ontime, 'max', 25, 'on_time_days', h.ok_n, 'due_days', h.due_n),
             'completed',  jsonb_build_object('points', h.p_done,   'max', 15, 'completed', h.completed, 'plans', h.plans),
             'self_paid',  jsonb_build_object('points', h.p_self,   'max', 10, 'self_ugx', h.self_amt, 'collected_ugx', h.tot_amt),
             'no_gaps',    jsonb_build_object('points', h.p_gap,    'max', 10, 'gaps_20_plus', h.gap_n)) AS components
      FROM hist h
    UNION ALL
    SELECT n.tenant_id,
           round(n.p_agent + n.p_trust)::int,
           'new'::text,
           format('New tenant: %s, %s',
                  CASE WHEN n.a_expected > 0
                       THEN 'agent portfolio paid ' || round(100 * LEAST(1, n.a_paid / n.a_expected)) || '% of what was owed'
                       ELSE 'no agent portfolio to measure yet' END,
                  CASE WHEN n.trust IS NOT NULL THEN 'trust score ' || n.trust ELSE 'no trust score on file' END),
           jsonb_build_object(
             'agent_portfolio', jsonb_build_object('points', n.p_agent, 'max', 60, 'agent_id', n.agent_id,
                                                   'paid', n.a_paid, 'expected', n.a_expected, 'plans', n.a_plans),
             'trust', jsonb_build_object('points', n.p_trust, 'max', 40, 'score', n.trust))
      FROM newt n
  )
  SELECT s.tenant_id, s.score, public._tps_label(s.score, s.basis), s.reason, s.basis, s.components
    FROM scored s;
$function$;

-- 3. The live function for staff -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tenant_payment_score(p_tenant_ids uuid[])
RETURNS TABLE (
  tenant_id uuid,
  score     integer,
  label     text,
  reason    text,
  basis     text
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
  IF p_tenant_ids IS NULL OR cardinality(p_tenant_ids) = 0 THEN
    RETURN;
  END IF;
  IF cardinality(p_tenant_ids) > 2000 THEN
    RAISE EXCEPTION 'Too many tenants in one call (max 2000)' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT s.tenant_id, s.score, s.label, s.reason, s.basis
      FROM public._tenant_payment_score_core(p_tenant_ids, (now() AT TIME ZONE 'Africa/Kampala')::date) s;
END;
$function$;

-- 4. Append-only daily snapshots --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_payment_score_daily (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  score_date  date        NOT NULL,
  tenant_id   uuid        NOT NULL,
  score       integer     NOT NULL CHECK (score BETWEEN 0 AND 100),
  label       text        NOT NULL CHECK (label IN ('proven_good', 'good_agent_pick', 'average', 'watch')),
  reason      text        NOT NULL,
  basis       text        NOT NULL CHECK (basis IN ('history', 'new')),
  components  jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (score_date, tenant_id)
);
CREATE INDEX IF NOT EXISTS tenant_payment_score_daily_tenant_idx ON public.tenant_payment_score_daily (tenant_id, score_date DESC);
COMMENT ON TABLE public.tenant_payment_score_daily IS
  'Append-only. One row per tenant per scoring day, written once by tenant_payment_score_run() at 00:45 Kampala, scored as at the day that had just closed. Staff read only.';

ALTER TABLE public.tenant_payment_score_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_payment_score_daily_staff_read ON public.tenant_payment_score_daily;
CREATE POLICY tenant_payment_score_daily_staff_read ON public.tenant_payment_score_daily
  FOR SELECT TO authenticated USING (public._am_staff_ok());

REVOKE ALL ON public.tenant_payment_score_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tenant_payment_score_daily TO authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON public.tenant_payment_score_daily FROM service_role;

CREATE OR REPLACE FUNCTION public._tenant_payment_score_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'tenant_payment_score_daily is append-only' USING ERRCODE = '42501';
END;
$function$;
DROP TRIGGER IF EXISTS tenant_payment_score_daily_append_only ON public.tenant_payment_score_daily;
CREATE TRIGGER tenant_payment_score_daily_append_only
  BEFORE UPDATE OR DELETE ON public.tenant_payment_score_daily
  FOR EACH ROW EXECUTE FUNCTION public._tenant_payment_score_append_only();
DROP TRIGGER IF EXISTS tenant_payment_score_daily_no_truncate ON public.tenant_payment_score_daily;
CREATE TRIGGER tenant_payment_score_daily_no_truncate
  BEFORE TRUNCATE ON public.tenant_payment_score_daily
  FOR EACH STATEMENT EXECUTE FUNCTION public._tenant_payment_score_append_only();

-- 5. The nightly job ----------------------------------------------------------------------------------------
-- Scores every tenant who has a request still in play (not rejected, cancelled or deleted) and an account that is
-- not deleted, as at the day that has just closed. Running it twice for the same day adds nothing.
CREATE OR REPLACE FUNCTION public.tenant_payment_score_run(p_as_at date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_as_at date := COALESCE(p_as_at, (now() AT TIME ZONE 'Africa/Kampala')::date - 1);
  v_ids uuid[];
  v_inserted integer;
  v_hist integer;
  v_new integer;
BEGIN
  SELECT ARRAY(
    SELECT DISTINCT r.tenant_id
      FROM public.rent_requests r
      JOIN public.profiles p ON p.id = r.tenant_id AND p.deleted_at IS NULL
     WHERE r.tenant_id IS NOT NULL AND r.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent'))
    INTO v_ids;

  WITH ins AS (
    INSERT INTO public.tenant_payment_score_daily (score_date, tenant_id, score, label, reason, basis, components)
    SELECT v_as_at, s.tenant_id, s.score, s.label, s.reason, s.basis, s.components
      FROM public._tenant_payment_score_core(v_ids, v_as_at) s
    ON CONFLICT (score_date, tenant_id) DO NOTHING
    RETURNING basis
  )
  SELECT count(*), count(*) FILTER (WHERE basis = 'history'), count(*) FILTER (WHERE basis = 'new')
    INTO v_inserted, v_hist, v_new FROM ins;

  RETURN jsonb_build_object('score_date', v_as_at, 'tenants', cardinality(v_ids),
                            'inserted', v_inserted, 'history', v_hist, 'new', v_new);
END;
$function$;

-- 6. Grants: the helpers and the job are not callable from the API; staff call the live function ---------------
REVOKE ALL ON FUNCTION public._tps_label(integer, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._tenant_payment_score_core(uuid[], date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._tenant_payment_score_append_only() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tenant_payment_score_run(date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tenant_payment_score(uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.tenant_payment_score(uuid[]) TO authenticated;

-- 7. Nightly at 00:45 Kampala (21:45 UTC the day before) ---------------------------------------------------------
DO $cron$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.schedule('tenant-payment-score-daily-0045-eat', '45 21 * * *', 'SELECT public.tenant_payment_score_run();');
  END IF;
END
$cron$;
