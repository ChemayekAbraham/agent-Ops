-- Rent-request desks: filters (paying label, arrival date) and the server's own count, on the one ordering RPC.
--
-- Read-only. Replaces rent_request_desk_order (20261014140000) with the same function plus optional filters, and re-states
-- _tenant_payment_score_core with one wording change. Not edited: any status transition, approval or review function,
-- get_service_center_rent_queue, tenant_payment_score, the score weights or labels, rent_requests or any other table.
--
--   rent_request_desk_order(p_request_ids, p_sort, p_labels, p_arrived, p_from, p_to)
--     p_sort      best_payers (default) | newest | oldest, exactly as before; the rank is over every request passed in.
--     p_labels    proven_good | good_agent_pick | average | watch (any of them); NULL or empty = no label filter. A request
--                 whose tenant has no score matches no label.
--     p_arrived   any (default) | today | 7d | custom. Arrival = the day the request was created, in Kampala. today = today;
--                 7d = the last 7 Kampala days, today included; custom = p_from..p_to inclusive (either end may be left open,
--                 not both). A request with no created_at matches no date filter.
--     returns     the old columns plus matches (does this request pass both filters?), match_count (how many requests do)
--                 and total_count (how many were ranked). Desks hide the rows with matches = false and show match_count as
--                 the count; the client never evaluates a label or a date itself. With no filter every row matches.
--     Anything else raises 22023. Access is unchanged: desk roles may rank any request, a Service Center manager only
--     requests routed to them.
--
--   _tenant_payment_score_core: the reason line now says "Rent Plan" / "Rent Plans" (was "plan" / "plans"). Scores, labels and
--   every other word are unchanged. Rows already stored in tenant_payment_score_daily keep the wording they were written with.

-- 1. The wording change ----------------------------------------------------------------------------------------
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
           format('Paid %s%% of what was owed, %s of %s due days on time, %s of %s Rent Plan%s completed, %s',
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

REVOKE ALL ON FUNCTION public._tenant_payment_score_core(uuid[], date) FROM PUBLIC, anon, authenticated, service_role;

-- 2. The ordering RPC with filters and counts ------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.rent_request_desk_order(uuid[], text);

CREATE OR REPLACE FUNCTION public.rent_request_desk_order(
  p_request_ids uuid[],
  p_sort        text   DEFAULT 'best_payers',
  p_labels      text[] DEFAULT NULL,
  p_arrived     text   DEFAULT NULL,
  p_from        date   DEFAULT NULL,
  p_to          date   DEFAULT NULL
)
RETURNS TABLE (
  request_id  uuid,
  tenant_id   uuid,
  rank        integer,
  score       integer,
  label       text,
  reason      text,
  basis       text,
  matches     boolean,
  match_count integer,
  total_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_sort   text := COALESCE(NULLIF(btrim(p_sort), ''), 'best_payers');
  v_arr    text := COALESCE(NULLIF(btrim(p_arrived), ''), 'any');
  v_labels text[] := CASE WHEN p_labels IS NULL OR cardinality(p_labels) = 0 THEN NULL ELSE p_labels END;
  v_today  date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_lo     date;
  v_hi     date;
  v_desk   boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_sort NOT IN ('best_payers', 'newest', 'oldest') THEN
    RAISE EXCEPTION 'p_sort must be best_payers, newest or oldest' USING ERRCODE = '22023';
  END IF;
  IF v_labels IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(v_labels) AS l(x)
                                       WHERE l.x IS NULL OR l.x NOT IN ('proven_good', 'good_agent_pick', 'average', 'watch')) THEN
    RAISE EXCEPTION 'p_labels must be proven_good, good_agent_pick, average or watch' USING ERRCODE = '22023';
  END IF;
  IF v_arr NOT IN ('any', 'today', '7d', 'custom') THEN
    RAISE EXCEPTION 'p_arrived must be any, today, 7d or custom' USING ERRCODE = '22023';
  END IF;
  IF v_arr = 'today' THEN
    v_lo := v_today; v_hi := v_today;
  ELSIF v_arr = '7d' THEN
    v_lo := v_today - 6; v_hi := v_today;          -- the last 7 Kampala days, today included
  ELSIF v_arr = 'custom' THEN
    IF p_from IS NULL AND p_to IS NULL THEN
      RAISE EXCEPTION 'a custom arrival range needs p_from or p_to' USING ERRCODE = '22023';
    END IF;
    IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
      RAISE EXCEPTION 'p_from must not be after p_to' USING ERRCODE = '22023';
    END IF;
    v_lo := COALESCE(p_from, '-infinity'::date); v_hi := COALESCE(p_to, 'infinity'::date);
  END IF;

  v_desk := public._am_staff_ok()
         OR EXISTS (SELECT 1 FROM public.user_roles ur
                     WHERE ur.user_id = v_uid AND ur.enabled = true
                       AND ur.role::text IN ('landlord_ops', 'partner_ops'));

  IF NOT v_desk THEN
    IF p_request_ids IS NULL OR cardinality(p_request_ids) = 0
       OR EXISTS (SELECT 1 FROM unnest(p_request_ids) AS i(id)
                   WHERE i.id IS NULL
                      OR NOT EXISTS (SELECT 1 FROM public.rent_requests rr
                                      WHERE rr.id = i.id AND rr.service_center_manager_id = v_uid)) THEN
      RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_request_ids IS NULL OR cardinality(p_request_ids) = 0 THEN
    RETURN;
  END IF;
  IF cardinality(p_request_ids) > 20000 THEN
    RAISE EXCEPTION 'Too many requests in one call (max 20000)' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH req AS (
    SELECT rr.id AS rid, rr.tenant_id AS tid, rr.created_at AS created,
           (rr.created_at AT TIME ZONE 'Africa/Kampala')::date AS created_day
      FROM public.rent_requests rr
     WHERE rr.id = ANY (p_request_ids)
  ),
  sc AS (
    SELECT s.tenant_id AS tid, s.score AS score, s.label AS label, s.reason AS reason, s.basis AS basis
      FROM public._tenant_payment_score_core(
             ARRAY(SELECT DISTINCT q.tid FROM req q WHERE q.tid IS NOT NULL),
             v_today) s
  ),
  ranked AS (
    SELECT r.rid, r.tid,
           (row_number() OVER (
              ORDER BY CASE WHEN v_sort = 'best_payers' THEN sc.score END DESC NULLS LAST,
                       CASE WHEN v_sort = 'newest' THEN r.created END DESC NULLS LAST,
                       CASE WHEN v_sort IN ('best_payers', 'oldest') THEN r.created END ASC NULLS LAST,
                       r.rid))::integer AS rnk,
           sc.score AS score, sc.label AS label, sc.reason AS reason, sc.basis AS basis,
           COALESCE((v_labels IS NULL OR sc.label = ANY (v_labels))
                    AND (v_lo IS NULL OR (r.created_day >= v_lo AND r.created_day <= v_hi)), false) AS ok
      FROM req r
      LEFT JOIN sc ON sc.tid = r.tid
  )
  SELECT k.rid, k.tid, k.rnk, k.score, k.label, k.reason, k.basis, k.ok,
         (count(*) FILTER (WHERE k.ok) OVER ())::integer,
         (count(*) OVER ())::integer
    FROM ranked k
   ORDER BY k.rnk;
END;
$function$;

REVOKE ALL ON FUNCTION public.rent_request_desk_order(uuid[], text, text[], text, date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.rent_request_desk_order(uuid[], text, text[], text, date, date) TO authenticated;
