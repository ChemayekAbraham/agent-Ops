-- Raise the statement timeout on the Agent Operations staff reads that
-- timed out under the authenticated 8 second cap, plus the payables forecast
-- that timed out in the same window.
--
-- In the four hours 11 Nov 2026 07:00-11:00 Africa/Kampala, Postgres logged
-- 129 statement timeouts (57014). 116 of them were:
--   get_agent_active_breakdown  58, 09:06:39-09:09:51 EAT
--   get_agent_ops_overview      58, same burst
-- Both were called from PostgREST with p_range_start / p_range_end and hit
-- the authenticated 8s cap. They had only SET search_path TO 'public'.
-- The burst sat at the start of a short database unavailability wave at
-- 09:07 EAT.
--
-- statement_timeout = 120s follows the finance pack and PR #79. Each body is
-- the live pg_get_functiondef. Arguments, defaults, volatility and grants are
-- unchanged. A later change should EXPLAIN and tighten the queries.
-- This migration is not applied to production from this branch.
--
-- get_payables_predictive_forecast: 4 timeouts in the same window.
-- Live before this rewrite: md5 e270d038cc344bd8e1cdc70791654044,
-- plpgsql, STABLE SECURITY DEFINER, SET search_path TO 'public',
-- SET jit TO 'off', EXECUTE for authenticated, postgres, service_role
-- (anon is not granted). Same treatment only: statement_timeout = 120s.
-- JIT stays off. The body is unchanged.
--
-- Version 20261113180000 is the first prefix later than every file already
-- in supabase/migrations (through 20261113170000) and later than live
-- schema_migrations (through 20261113040000). 20261113050000 would not have
-- been later than the funder migrations already on lovable.


CREATE OR REPLACE FUNCTION public.get_agent_active_breakdown(p_range_start timestamp with time zone, p_range_end timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_prev_start timestamptz;
  v_prev_end timestamptz := p_range_start;
  v_span interval;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;
  IF NOT (
    public.is_ops_role(v_uid)
    OR public.has_role(v_uid, 'manager')
    OR public.has_role(v_uid, 'cfo')
    OR public.has_role(v_uid, 'ceo')
    OR public.has_role(v_uid, 'coo')
    OR public.has_role(v_uid, 'cto')
    OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  v_span := p_range_end - p_range_start;
  v_prev_start := p_range_start - v_span;

  WITH links AS (
    SELECT DISTINCT sub_agent_id, parent_agent_id
      FROM agent_subagents
     WHERE sub_agent_id IS NOT NULL AND parent_agent_id IS NOT NULL
  ),
  sub_ids AS (SELECT DISTINCT sub_agent_id FROM links),
  coll AS (
    SELECT ac.agent_id AS uid,
           (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS day,
           ac.created_at
      FROM agent_collections ac
     WHERE ac.agent_id IS NOT NULL
       AND ac.reversed_at IS NULL
       AND ac.created_at >= v_prev_start
       AND ac.created_at < p_range_end
  ),
  w AS (
    SELECT uid, day,
           (created_at >= p_range_start AND created_at < p_range_end) AS is_curr,
           (created_at >= v_prev_start AND created_at < v_prev_end) AS is_prev
      FROM coll
  ),
  subs AS (
    SELECT w.uid, w.day, w.is_curr, w.is_prev
      FROM w WHERE w.uid IN (SELECT sub_agent_id FROM sub_ids)
  ),
  direct AS (
    SELECT w.uid, w.day, w.is_curr, w.is_prev
      FROM w WHERE NOT EXISTS (SELECT 1 FROM sub_ids si WHERE si.sub_agent_id = w.uid)
  ),
  via_team AS (
    SELECT l.parent_agent_id AS uid, s.day, s.is_curr, s.is_prev
      FROM subs s
      JOIN links l ON l.sub_agent_id = s.uid
     WHERE NOT EXISTS (SELECT 1 FROM sub_ids si WHERE si.sub_agent_id = l.parent_agent_id)
  ),
  agents AS (
    SELECT * FROM direct
    UNION ALL
    SELECT * FROM via_team
  ),
  days AS (
    SELECT generate_series(
             date_trunc('day', p_range_start),
             date_trunc('day', p_range_end - interval '1 second'),
             interval '1 day'
           ) AS ts
  ),
  a_day AS (SELECT day, count(DISTINCT uid) n FROM agents WHERE is_curr GROUP BY day),
  s_day AS (SELECT day, count(DISTINCT uid) n FROM subs WHERE is_curr GROUP BY day),
  daily AS (
    SELECT d.ts, COALESCE(ad.n, 0) AS agents, COALESCE(sd.n, 0) AS subagents
      FROM days d
      LEFT JOIN a_day ad ON ad.day = (d.ts AT TIME ZONE 'Africa/Kampala')::date
      LEFT JOIN s_day sd ON sd.day = (d.ts AT TIME ZONE 'Africa/Kampala')::date
  )
  SELECT jsonb_build_object(
    'agents_curr',    (SELECT count(DISTINCT uid) FROM agents WHERE is_curr),
    'agents_prev',    (SELECT count(DISTINCT uid) FROM agents WHERE is_prev),
    'subagents_curr', (SELECT count(DISTINCT uid) FROM subs WHERE is_curr),
    'subagents_prev', (SELECT count(DISTINCT uid) FROM subs WHERE is_prev),
    'total_curr',     (SELECT count(DISTINCT uid) FROM agents WHERE is_curr)
                      + (SELECT count(DISTINCT uid) FROM subs WHERE is_curr),
    'total_prev',     (SELECT count(DISTINCT uid) FROM agents WHERE is_prev)
                      + (SELECT count(DISTINCT uid) FROM subs WHERE is_prev),
    'trend',          COALESCE((SELECT jsonb_agg(jsonb_build_object(
                         'day', ts, 'agents', agents, 'subagents', subagents
                       ) ORDER BY ts) FROM daily), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_agent_active_breakdown(timestamp with time zone, timestamp with time zone) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_agent_active_breakdown(timestamp with time zone, timestamp with time zone) TO authenticated, postgres, service_role;

CREATE OR REPLACE FUNCTION public.get_agent_ops_overview(p_range_start timestamp with time zone, p_range_end timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_prev_start timestamptz;
  v_prev_end timestamptz := p_range_start;
  v_span interval;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_kpis jsonb;
  v_trend jsonb;
  v_funnel jsonb;
  v_top jsonb;
  v_bucket text;
  v_bucket_fmt text;
  v_days int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;
  IF NOT (
    public.is_ops_role(v_uid)
    OR public.has_role(v_uid, 'manager')
    OR public.has_role(v_uid, 'cfo')
    OR public.has_role(v_uid, 'ceo')
    OR public.has_role(v_uid, 'coo')
    OR public.has_role(v_uid, 'cto')
    OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  v_span := p_range_end - p_range_start;
  v_prev_start := p_range_start - v_span;
  v_days := GREATEST(1, LEAST(31, CEIL(EXTRACT(EPOCH FROM v_span) / 86400)::int));
  IF v_days <= 1 THEN v_bucket := 'hour'; v_bucket_fmt := 'hour';
  ELSE v_bucket := 'day'; v_bucket_fmt := 'day';
  END IF;

  CREATE TEMP TABLE tmp_qual (agent_id uuid PRIMARY KEY, first_ts timestamptz NOT NULL) ON COMMIT DROP;

  -- Agent definition (baseline 2026-09-02): union of agents that collected rent
  -- (agent_collections) and agents acting on a rent request (any status),
  -- excluding self-requests where the acting agent is the tenant.
  -- NOTE: reversed collections are deliberately NOT excluded here. This is an
  -- identity/first-seen question, not a money one, and filtering it would move
  -- the agent counts every other figure is compared against.
  WITH base_ts AS (
    SELECT ac.agent_id AS uid, MIN(ac.created_at) AS ts
      FROM agent_collections ac
     WHERE ac.agent_id IS NOT NULL
     GROUP BY ac.agent_id
    UNION ALL
    SELECT COALESCE(rr.assigned_agent_id, rr.agent_id) AS uid, MIN(rr.created_at) AS ts
      FROM rent_requests rr
     WHERE COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL
       AND COALESCE(rr.assigned_agent_id, rr.agent_id) <> rr.tenant_id
     GROUP BY COALESCE(rr.assigned_agent_id, rr.agent_id)
  )
  INSERT INTO tmp_qual (agent_id, first_ts)
  SELECT uid, MIN(ts) FROM base_ts WHERE uid IS NOT NULL GROUP BY uid;

  -- Sub-agent set (earliest link per sub-agent, counted separately from agents)
  CREATE TEMP TABLE tmp_sub (sub_agent_id uuid PRIMARY KEY, first_ts timestamptz NOT NULL) ON COMMIT DROP;
  INSERT INTO tmp_sub (sub_agent_id, first_ts)
  SELECT sub_agent_id, MIN(created_at)
    FROM agent_subagents
    WHERE sub_agent_id IS NOT NULL
    GROUP BY sub_agent_id;

  -- One grouped pass over the wallet commission legs for both windows.
  -- commission_curr, commission_prev, the trend series and top-performer
  -- commission all read this instead of scanning general_ledger again.
  CREATE TEMP TABLE tmp_comm ON COMMIT DROP AS
  SELECT (created_at >= p_range_start) AS is_curr,
         date_trunc(v_bucket_fmt, created_at) AS ts,
         user_id AS uid,
         (category IN ('agent_commission_earned','agent_commission','agent_bonus')) AS narrow,
         sum(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END) AS n
    FROM general_ledger
   WHERE ledger_scope='wallet' AND direction IN ('cash_in','credit','cash_out','debit')
     AND category IN ('agent_commission_earned','agent_commission','agent_bonus','agent_investment_commission','proxy_investment_commission','partner_commission')
     AND created_at >= v_prev_start AND created_at < p_range_end
   GROUP BY 1,2,3,4;

  WITH
  -- Active = collected rent in the window (agent_collections only, baseline rule).
  -- A reversed collection is not a collection: it must not make an agent active,
  -- nor appear in any total below.
  active_curr AS (
    SELECT DISTINCT agent_id AS uid FROM agent_collections
      WHERE agent_id IS NOT NULL AND reversed_at IS NULL
        AND created_at >= p_range_start AND created_at < p_range_end
  ),
  active_prev AS (
    SELECT DISTINCT agent_id AS uid FROM agent_collections
      WHERE agent_id IS NOT NULL AND reversed_at IS NULL
        AND created_at >= v_prev_start AND created_at < v_prev_end
  )
  SELECT jsonb_build_object(
    'total_users',              (SELECT count(*) FROM profiles),
    'total_agents',             (SELECT count(*) FROM tmp_qual WHERE first_ts < p_range_end),
    'total_agents_prev',        (SELECT count(*) FROM tmp_qual WHERE first_ts < v_prev_end),
    'total_agents_all_time',    (SELECT count(*) FROM tmp_qual),
    'active_agents_curr',       (SELECT count(*) FROM active_curr WHERE uid IN (SELECT agent_id FROM tmp_qual WHERE first_ts < p_range_end)),
    'active_agents_prev',       (SELECT count(*) FROM active_prev WHERE uid IN (SELECT agent_id FROM tmp_qual WHERE first_ts < v_prev_end)),
    'new_agents_curr',          (SELECT count(*) FROM tmp_qual WHERE first_ts >= p_range_start AND first_ts < p_range_end),
    'new_agents_prev',          (SELECT count(*) FROM tmp_qual WHERE first_ts >= v_prev_start AND first_ts < v_prev_end),
    'total_subagents',          (SELECT count(*) FROM tmp_sub WHERE first_ts < p_range_end),
    'total_subagents_prev',     (SELECT count(*) FROM tmp_sub WHERE first_ts < v_prev_end),
    'new_subagents_curr',       (SELECT count(*) FROM tmp_sub WHERE first_ts >= p_range_start AND first_ts < p_range_end),
    'new_subagents_prev',       (SELECT count(*) FROM tmp_sub WHERE first_ts >= v_prev_start AND first_ts < v_prev_end),
    'active_subagents_curr',    (SELECT count(*) FROM active_curr WHERE uid IN (SELECT sub_agent_id FROM tmp_sub WHERE first_ts < p_range_end)),
    'active_subagents_prev',    (SELECT count(*) FROM active_prev WHERE uid IN (SELECT sub_agent_id FROM tmp_sub WHERE first_ts < v_prev_end)),
    'rent_req_curr',            (SELECT count(*) FROM rent_requests WHERE created_at >= p_range_start AND created_at < p_range_end),
    'rent_req_prev',            (SELECT count(*) FROM rent_requests WHERE created_at >= v_prev_start AND created_at < v_prev_end),
    'rent_req_amount_curr',     (SELECT COALESCE(sum(rent_amount),0) FROM rent_requests WHERE created_at >= p_range_start AND created_at < p_range_end),
    'verified_houses_curr',     (SELECT count(*) FROM house_listings WHERE verified = true AND verified_at >= p_range_start AND verified_at < p_range_end),
    'verified_houses_prev',     (SELECT count(*) FROM house_listings WHERE verified = true AND verified_at >= v_prev_start AND verified_at < v_prev_end),
    'collections_today',        (SELECT COALESCE(sum(amount),0) FROM agent_collections WHERE reversed_at IS NULL AND (created_at AT TIME ZONE 'Africa/Kampala')::date = v_today),
    'collections_today_count',  (SELECT count(*) FROM agent_collections WHERE reversed_at IS NULL AND (created_at AT TIME ZONE 'Africa/Kampala')::date = v_today),
    -- Today measured against TODAY'S BILL. `collections_today` above is all
    -- cash in the door and includes arrears, so it is NOT the numerator for
    -- `expected_today`. Use these together, never as a single ratio.
    'expected_today', (SELECT COALESCE(sum(expected_ugx),0)
                          FROM public.agent_expected_day_plans WHERE day = v_today),
    'plans_billed_today', (SELECT count(*) FROM public.agent_expected_day_plans WHERE day = v_today),
    'collected_on_schedule_today', (SELECT COALESCE(sum(LEAST(COALESCE(p.paid,0), b.expected_ugx)),0)
                          FROM public.agent_expected_day_plans b
                          LEFT JOIN LATERAL (SELECT sum(ac.amount) AS paid FROM public.agent_collections ac
                             WHERE ac.rent_request_id = b.rent_request_id AND ac.reversed_at IS NULL
                               AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date = v_today) p ON true
                         WHERE b.day = v_today),
    'pending_today', (SELECT COALESCE(sum(b.expected_ugx - LEAST(COALESCE(p.paid,0), b.expected_ugx)),0)
                          FROM public.agent_expected_day_plans b
                          LEFT JOIN LATERAL (SELECT sum(ac.amount) AS paid FROM public.agent_collections ac
                             WHERE ac.rent_request_id = b.rent_request_id AND ac.reversed_at IS NULL
                               AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date = v_today) p ON true
                         WHERE b.day = v_today),
    'collections_curr',         (SELECT COALESCE(sum(amount),0) FROM agent_collections WHERE reversed_at IS NULL AND created_at >= p_range_start AND created_at < p_range_end),
    'collections_prev',         (SELECT COALESCE(sum(amount),0) FROM agent_collections WHERE reversed_at IS NULL AND created_at >= v_prev_start AND created_at < v_prev_end),
    'collections_count_curr',   (SELECT count(*) FROM agent_collections WHERE reversed_at IS NULL AND created_at >= p_range_start AND created_at < p_range_end),
    'collections_count_prev',   (SELECT count(*) FROM agent_collections WHERE reversed_at IS NULL AND created_at >= v_prev_start AND created_at < v_prev_end),
    'pending_collections',      (SELECT COALESCE(sum(GREATEST(COALESCE(total_repayment,0) - COALESCE(amount_repaid,0), 0)),0)
                                   FROM rent_requests
                                   WHERE status = 'repaying'
                                     AND COALESCE(tenancy_status,'active') <> 'ended'),
    -- Commission is reported NET. A reversal is posted in the same category
    -- with direction cash_out; counting only cash_in reported gross earnings
    -- and silently ignored every reversal ever made.
    'commission_curr',          (SELECT COALESCE(sum(n),0) FROM tmp_comm WHERE is_curr),
    'commission_prev',          (SELECT COALESCE(sum(n),0) FROM tmp_comm WHERE NOT is_curr),
    'outstanding_advances',     (SELECT COALESCE(sum(outstanding_balance),0) FROM agent_advances WHERE status IN ('active','disbursed','overdue')),
    'active_advances_count',    (SELECT count(*) FROM agent_advances WHERE status IN ('active','disbursed','overdue')),
    'behind_advances_count',    (SELECT count(*) FROM agent_advances WHERE status IN ('active','disbursed','overdue') AND COALESCE(arrears_balance,0) > 0),
    'arrears_total',            (SELECT COALESCE(sum(arrears_balance),0) FROM agent_advances WHERE status IN ('active','disbursed','overdue')),
    'pending_advance_requests', (SELECT count(*) FROM agent_advance_requests WHERE status = 'pending'),
    'rent_pending',             (SELECT count(*) FROM rent_requests WHERE status='pending'  AND created_at >= p_range_start AND created_at < p_range_end),
    'rent_approved',            (SELECT count(*) FROM rent_requests WHERE status IN ('approved','disbursed','funded') AND created_at >= p_range_start AND created_at < p_range_end),
    'rent_repaying',            (SELECT count(*) FROM rent_requests WHERE status='repaying' AND created_at >= p_range_start AND created_at < p_range_end),
    'rent_rejected',            (SELECT count(*) FROM rent_requests WHERE status IN ('rejected','deleted_by_agent') AND created_at >= p_range_start AND created_at < p_range_end)
  ) INTO v_kpis;

  SELECT jsonb_build_object(
    'listed',   (SELECT count(*) FROM house_listings WHERE created_at >= p_range_start AND created_at < p_range_end),
    'verified', (SELECT count(*) FROM house_listings WHERE created_at >= p_range_start AND created_at < p_range_end AND verified = true),
    'placed',   (SELECT count(*) FROM house_listings WHERE created_at >= p_range_start AND created_at < p_range_end AND tenant_id IS NOT NULL)
  ) INTO v_funnel;

  WITH buckets AS (
    SELECT generate_series(
      date_trunc(v_bucket_fmt, p_range_start),
      date_trunc(v_bucket_fmt, p_range_end - interval '1 second'),
      (('1 ' || v_bucket_fmt))::interval
    ) AS ts
  ),
  new_agents AS (
    SELECT date_trunc(v_bucket_fmt, first_ts) AS ts, count(*) AS n
      FROM tmp_qual WHERE first_ts >= p_range_start AND first_ts < p_range_end GROUP BY 1
  ),
  reqs AS (
    SELECT date_trunc(v_bucket_fmt, created_at) AS ts, count(*) AS n
      FROM rent_requests WHERE created_at >= p_range_start AND created_at < p_range_end GROUP BY 1
  ),
  cols AS (
    SELECT date_trunc(v_bucket_fmt, created_at) AS ts, COALESCE(sum(amount),0) AS n
      FROM agent_collections WHERE reversed_at IS NULL AND created_at >= p_range_start AND created_at < p_range_end GROUP BY 1
  ),
  comm AS (
    SELECT ts, COALESCE(sum(n),0) AS n
      FROM tmp_comm
     WHERE is_curr
     GROUP BY ts
  ),
  active_bkt AS (
    SELECT ts, count(DISTINCT uid) AS n FROM (
      SELECT date_trunc(v_bucket_fmt, created_at) AS ts, agent_id AS uid FROM agent_collections
        WHERE agent_id IS NOT NULL AND reversed_at IS NULL
          AND created_at >= p_range_start AND created_at < p_range_end
    ) s
    WHERE uid IN (SELECT agent_id FROM tmp_qual WHERE first_ts < p_range_end)
    GROUP BY ts
  ),
  expected AS (
    SELECT b.ts,
           COALESCE((SELECT sum(pp.expected_ugx) FROM public.agent_expected_day_plans pp WHERE pp.day = (b.ts AT TIME ZONE 'Africa/Kampala')::date), 0) * (CASE WHEN v_bucket_fmt = 'hour' THEN 1.0/24.0 ELSE 1.0 END) AS n
      FROM buckets b
      LEFT JOIN rent_requests rr
        ON rr.status = 'repaying'
       AND COALESCE(rr.tenancy_status,'active') <> 'ended'
       AND COALESCE(rr.disbursed_at, rr.funded_at, rr.approved_at, rr.created_at) <= b.ts
     GROUP BY b.ts
  )
  SELECT jsonb_agg(jsonb_build_object(
    'day', b.ts,
    'agents',       COALESCE(na.n, 0),
    'active_agents',COALESCE(ab.n, 0),
    'requests',     COALESCE(rq.n, 0),
    'collections',  COALESCE(cl.n, 0),
    'commission',   COALESCE(cm.n, 0),
    'expected',     ROUND(COALESCE(ex.n, 0)),
    'pending',      GREATEST(ROUND(COALESCE(ex.n, 0)) - COALESCE(cl.n, 0), 0)
  ) ORDER BY b.ts)
  INTO v_trend
  FROM buckets b
    LEFT JOIN new_agents na  ON na.ts = b.ts
    LEFT JOIN reqs rq        ON rq.ts = b.ts
    LEFT JOIN cols cl        ON cl.ts = b.ts
    LEFT JOIN comm cm        ON cm.ts = b.ts
    LEFT JOIN active_bkt ab  ON ab.ts = b.ts
    LEFT JOIN expected ex    ON ex.ts = b.ts;

  WITH collected AS (
    SELECT agent_id AS uid,
           COALESCE(sum(amount),0) AS collected,
           count(*) AS collections
      FROM agent_collections
     WHERE agent_id IS NOT NULL
       AND reversed_at IS NULL
       AND created_at >= p_range_start AND created_at < p_range_end
     GROUP BY agent_id
  ),
  commissions AS (
    SELECT uid,
           COALESCE(sum(n),0) AS commission
      FROM tmp_comm
     WHERE is_curr AND narrow
     GROUP BY uid
  ),
  merged AS (
    SELECT COALESCE(c.uid, m.uid) AS uid,
           COALESCE(c.collected, 0) AS collected,
           COALESCE(c.collections, 0) AS collections,
           COALESCE(m.commission, 0) AS commission
      FROM collected c
      FULL OUTER JOIN commissions m ON m.uid = c.uid
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'user_id', t.uid,
    'name', COALESCE(p.full_name, 'Unknown'),
    'phone', p.phone,
    'category', CASE WHEN s.sub_agent_id IS NOT NULL THEN 'Sub-Agent' ELSE 'Agent' END,
    'collected', t.collected,
    'collections', t.collections,
    'commission', t.commission
  ) ORDER BY t.collected DESC, t.commission DESC), '[]'::jsonb)
  INTO v_top
  FROM (
    SELECT * FROM merged WHERE uid IS NOT NULL ORDER BY collected DESC, commission DESC LIMIT 5
  ) t
  LEFT JOIN profiles p ON p.id = t.uid
  LEFT JOIN tmp_sub s ON s.sub_agent_id = t.uid;

  RETURN jsonb_build_object(
    'range', jsonb_build_object('start', p_range_start, 'end', p_range_end),
    'kpis', v_kpis,
    'listings_funnel', v_funnel,
    'trend', COALESCE(v_trend, '[]'::jsonb),
    'top_performers', COALESCE(v_top, '[]'::jsonb),
    'generated_at', now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_agent_ops_overview(timestamp with time zone, timestamp with time zone) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_agent_ops_overview(timestamp with time zone, timestamp with time zone) TO authenticated, postgres, service_role;

CREATE OR REPLACE FUNCTION public.get_payables_predictive_forecast(p_granularity text DEFAULT 'month'::text, p_periods integer DEFAULT 12, p_as_at date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET jit TO 'off'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_gran text := lower(COALESCE(p_granularity, 'month'));
  v_periods integer := LEAST(GREATEST(COALESCE(p_periods, 12), 1), 60);
  v_today date := COALESCE(p_as_at, (now() AT TIME ZONE 'Africa/Nairobi')::date);
  v_result jsonb;
BEGIN
  PERFORM payables_guard();
  IF v_gran NOT IN ('day','week','month','quarter','year') THEN
    v_gran := 'month';
  END IF;

WITH payables_lines_snap AS MATERIALIZED (SELECT * FROM v_payables_lines),
float_payables_snap AS MATERIALIZED (SELECT * FROM v_landlord_float_payables),
payout_settlement_snap AS MATERIALIZED (SELECT * FROM v_landlord_payout_settlement),
params AS (
  SELECT v_gran AS gran, v_periods AS periods, v_today AS today, 365 AS lookback,
         CASE v_gran WHEN 'day' THEN interval '1 day' WHEN 'week' THEN interval '1 week'
              WHEN 'month' THEN interval '1 month' WHEN 'quarter' THEN interval '3 months'
              ELSE interval '1 year' END AS step,
         CASE v_gran WHEN 'day' THEN v_today
              WHEN 'week' THEN date_trunc('week', v_today)::date
              WHEN 'month' THEN date_trunc('month', v_today)::date
              WHEN 'quarter' THEN date_trunc('quarter', v_today)::date
              ELSE date_trunc('year', v_today)::date END AS base
), hist AS (
  SELECT h.category_key ck, h.product_key pk, h.d, SUM(h.amount) amt
  FROM v_payables_payment_history h CROSS JOIN params p
  WHERE h.d IS NOT NULL AND h.d > p.today - p.lookback AND h.d <= p.today AND h.amount > 0
  GROUP BY 1,2,3
), span AS (
  -- Payables scope (CFO, 2026-10-21): no landlord run-off stream. The landlord payable is the weekly float line, carried
  -- at its scheduled date; landlord payment history stays in 'history' (actual payments) only.
  SELECT ck, pk, MIN(d) first_d, COUNT(*) sample_days FROM hist WHERE ck <> 'landlord' GROUP BY 1,2
), dense AS (
  SELECT s.ck, s.pk, g::date d, COALESCE(h.amt,0) amt
  FROM span s CROSS JOIN params p
  CROSS JOIN LATERAL generate_series(s.first_d, p.today, interval '1 day') g
  LEFT JOIN hist h ON h.ck = s.ck AND h.pk = s.pk AND h.d = g::date
), lvl AS (
  SELECT d.ck, d.pk,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY d.amt) FILTER (WHERE d.d > p.today - 28) AS level_recent,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY d.amt) FILTER (WHERE d.d > p.today - 42 AND d.d <= p.today - 14) AS level_prior,
    SUM(d.amt) FILTER (WHERE d.d > p.today - 14) AS holdout_actual
  FROM dense d CROSS JOIN params p GROUP BY 1,2
), slope AS (
  SELECT ck, pk, regr_slope(wk_amt, wk_idx) / 7.0 AS slope_per_day
  FROM (SELECT d.ck, d.pk, (d.d - p.today)/7 AS wk_idx, SUM(d.amt) wk_amt
        FROM dense d CROSS JOIN params p GROUP BY 1,2,3) w
  GROUP BY 1,2
), dowf AS (
  SELECT w.ck, w.pk, w.dw,
    CASE WHEN l.level_recent > 0 THEN LEAST(2.5, GREATEST(0.1, w.med_dow / l.level_recent)) ELSE 1 END AS f
  FROM (SELECT d.ck, d.pk, EXTRACT(dow FROM d.d)::int dw,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY d.amt) AS med_dow
        FROM dense d CROSS JOIN params p WHERE d.d > p.today - 84 GROUP BY 1,2,3) w
  JOIN lvl l ON l.ck=w.ck AND l.pk=w.pk
), model AS (
  SELECT s.ck, s.pk, s.sample_days, (p.today - s.first_d + 1) AS lookback_days,
    COALESCE(l.level_recent,0) AS level,
    COALESCE(sl.slope_per_day,0) AS slope_per_day,
    CASE WHEN COALESCE(l.holdout_actual,0) > 0
      THEN LEAST(1.5, ABS(COALESCE(l.level_prior,0)*14 - l.holdout_actual) / l.holdout_actual)
      ELSE NULL END AS mape,
    CASE WHEN s.sample_days < 8 OR COALESCE(l.level_recent,0) <= 0 THEN 'insufficient_data'
         WHEN s.sample_days < 21 THEN 'robust_level'
         WHEN s.sample_days < 60 THEN 'level_plus_trend'
         ELSE 'seasonal_level_trend' END AS method
  FROM span s CROSS JOIN params p
  LEFT JOIN lvl l ON l.ck=s.ck AND l.pk=s.pk
  LEFT JOIN slope sl ON sl.ck=s.ck AND sl.pk=s.pk
), labels AS (
  -- one label per (category, product): the period totals join here, so a second label must never duplicate a row
  SELECT DISTINCT ON (category_key, product_key) category_key ck, category_label cl, product_key pk, product_label pl
    FROM payables_lines_snap ORDER BY category_key, product_key, product_label
), outs AS (
  SELECT category_key ck, product_key pk, ROUND(SUM(outstanding_amount),2) outstanding
  FROM payables_lines_snap GROUP BY 1,2
), orig_raw AS (
  -- New obligations created, per day, from the obligation tables themselves
  -- Payables scope (CFO, 2026-10-21): only Supporter Returns and agent commissions originate here. Withdrawal
  -- requests and payroll are no longer payables; the landlord payable is the weekly float line (scheduled at the end of
  -- its week below), so per-payout landlord originations would count it twice.
  SELECT 'agent'::text ck, 'agent_commission_payout'::text pk,
         (cp.created_at AT TIME ZONE 'Africa/Nairobi')::date d, COALESCE(cp.amount,0)::numeric amt
  FROM agent_commission_payouts cp
  WHERE cp.status <> 'rejected'
  UNION ALL
  SELECT 'partner','supporter_returns',(g.transaction_date AT TIME ZONE 'Africa/Nairobi')::date, COALESCE(g.amount,0)
  FROM general_ledger g
  WHERE g.category = 'roi_accrued'
), orig_hist AS (
  SELECT o.ck, o.pk, o.d, SUM(o.amt) amt
  FROM orig_raw o CROSS JOIN params p
  WHERE o.d IS NOT NULL AND o.d > p.today - p.lookback AND o.d <= p.today AND o.amt > 0
  GROUP BY 1,2,3
), orig_span AS (
  SELECT ck, pk, MIN(d) first_d, COUNT(*) sample_days FROM orig_hist GROUP BY 1,2
), orig_dense AS (
  SELECT s.ck, s.pk, g::date d, COALESCE(h.amt,0) amt
  FROM orig_span s CROSS JOIN params p
  CROSS JOIN LATERAL generate_series(s.first_d, p.today, interval '1 day') g
  LEFT JOIN orig_hist h ON h.ck = s.ck AND h.pk = s.pk AND h.d = g::date
), orig_lvl AS (
  SELECT d.ck, d.pk,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY d.amt) FILTER (WHERE d.d > p.today - 28) AS level_recent,
    AVG(d.amt) FILTER (WHERE d.d > p.today - 28) AS mean_recent
  FROM orig_dense d CROSS JOIN params p GROUP BY 1,2
), orig_slope AS (
  SELECT ck, pk, regr_slope(wk_amt, wk_idx) / 7.0 AS slope_per_day
  FROM (SELECT d.ck, d.pk, (d.d - p.today)/7 AS wk_idx, SUM(d.amt) wk_amt
        FROM orig_dense d CROSS JOIN params p GROUP BY 1,2,3) w
  GROUP BY 1,2
), orig_totals AS (
  SELECT ck, pk, SUM(amt) AS originated_lookback FROM orig_hist GROUP BY 1,2
), paid_totals AS (
  SELECT ck, pk, SUM(amt) AS paid_lookback FROM hist GROUP BY 1,2
), orig_model AS (
  SELECT s.ck, s.pk, s.sample_days,
    GREATEST(COALESCE(l.level_recent,0), COALESCE(l.mean_recent,0) * 0.5) AS level,
    COALESCE(sl.slope_per_day,0) AS slope_per_day,
    LEAST(1.0, GREATEST(0.05,
      COALESCE(pt.paid_lookback,0) / NULLIF(ot.originated_lookback,0)
    )) AS payment_rate,
    LEAST(730, GREATEST(7,
      COALESCE(o.outstanding,0) / NULLIF(GREATEST(m.level, 1), 0)
    )) AS term_days,
    CASE WHEN s.sample_days < 8 THEN 'insufficient_data'
         WHEN s.sample_days < 21 THEN 'robust_level'
         ELSE 'level_plus_trend' END AS method
  FROM orig_span s
  LEFT JOIN orig_lvl l ON l.ck=s.ck AND l.pk=s.pk
  LEFT JOIN orig_slope sl ON sl.ck=s.ck AND sl.pk=s.pk
  LEFT JOIN orig_totals ot ON ot.ck=s.ck AND ot.pk=s.pk
  LEFT JOIN paid_totals pt ON pt.ck=s.ck AND pt.pk=s.pk
  LEFT JOIN outs o ON o.ck=s.ck AND o.pk=s.pk
  LEFT JOIN model m ON m.ck=s.ck AND m.pk=s.pk
), periods AS (
  SELECT i,
    (p.base + (p.step * i))::date AS period_start,
    ((p.base + (p.step * (i+1))) - interval '1 day')::date AS period_end
  FROM params p CROSS JOIN generate_series(0, p.periods - 1) i
), horizon AS (
  SELECT MIN(GREATEST(period_start, (SELECT today FROM params))) f, MAX(period_end) t FROM periods
), day_fc AS (
  SELECT m.ck, m.pk, g::date d,
    GREATEST(0::numeric,
      (m.level + m.slope_per_day
        * LEAST(1, GREATEST(0.15, 1 - COALESCE(m.mape, 0.7)))
        * (1.0 / (1 + ((g::date - p.today)::numeric / 365.0)))
        * (g::date - p.today))
      * CASE WHEN m.method = 'seasonal_level_trend' THEN COALESCE(f.f, 1) ELSE 1 END
    ) AS amt
  FROM model m
  CROSS JOIN params p
  CROSS JOIN horizon h
  CROSS JOIN LATERAL generate_series(h.f, h.t, interval '1 day') g
  LEFT JOIN dowf f ON f.ck = m.ck AND f.pk = m.pk AND f.dw = EXTRACT(dow FROM g)::int
  WHERE m.method <> 'insufficient_data'
), day_orig AS (
  SELECT om.ck, om.pk, g::date d,
    GREATEST(0::numeric,
      LEAST(
        om.level * 3.0,
        om.level + om.slope_per_day
          * (1.0 / (1 + ((g::date - p.today)::numeric / 365.0)))
          * (g::date - p.today)
      )
      * om.payment_rate
      * LEAST(1.0, ((g::date - p.today)::numeric + 1) / om.term_days)
    ) AS amt
  FROM orig_model om
  CROSS JOIN params p
  CROSS JOIN horizon h
  CROSS JOIN LATERAL generate_series(h.f, h.t, interval '1 day') g
  WHERE om.method <> 'insufficient_data'
), fc_period AS (
  SELECT pr.i, df.ck, df.pk, ROUND(SUM(df.amt)::numeric,2) amt
  FROM day_fc df JOIN periods pr ON df.d BETWEEN pr.period_start AND pr.period_end
  GROUP BY 1,2,3
), orig_period AS (
  SELECT pr.i, df.ck, df.pk, ROUND(SUM(df.amt)::numeric,2) amt
  FROM day_orig df JOIN periods pr ON df.d BETWEEN pr.period_start AND pr.period_end
  GROUP BY 1,2,3
), fc_split AS (
  SELECT f.*, o.outstanding,
    SUM(f.amt) OVER (PARTITION BY f.ck, f.pk ORDER BY f.i) AS cum
  FROM fc_period f LEFT JOIN outs o ON o.ck=f.ck AND o.pk=f.pk
), fc_final AS (
  SELECT i, ck, pk,
    ROUND(LEAST(cum, COALESCE(outstanding,0)) - LEAST(cum - amt, COALESCE(outstanding,0)), 2) AS runoff
  FROM fc_split
), modelled AS (
  SELECT COALESCE(r.i, o.i) i, COALESCE(r.ck, o.ck) ck, COALESCE(r.pk, o.pk) pk,
    COALESCE(r.runoff,0) AS runoff, COALESCE(o.amt,0) AS new_orig
  FROM fc_final r
  FULL OUTER JOIN orig_period o ON o.i=r.i AND o.ck=r.ck AND o.pk=r.pk
), sched AS (
  -- Payables scope (CFO, 2026-10-21): a scheduled item already past its due date and still outstanding is carried into
  -- the period that contains today (basis 'overdue') until it is settled, so an ended landlord float or a past-due
  -- budget line never drops out of the forecast. Each line lands in exactly one period; zero-value lines are skipped.
  SELECT pr.i, l.category_key ck, l.product_key pk,
         CASE WHEN l.due_date < (SELECT today FROM params) THEN 'overdue' ELSE 'scheduled' END AS basis,
         ROUND(SUM(l.outstanding_amount),2) amt
  FROM payables_lines_snap l
  JOIN periods pr ON GREATEST(l.due_date, (SELECT today FROM params))
                     BETWEEN GREATEST(pr.period_start, (SELECT today FROM params)) AND pr.period_end
  WHERE l.due_date IS NOT NULL AND l.outstanding_amount <> 0
    AND NOT EXISTS (SELECT 1 FROM model m WHERE m.ck=l.category_key AND m.pk=l.product_key AND m.method <> 'insufficient_data')
  GROUP BY 1,2,3,4
), combined AS (
  SELECT i, ck, pk, (runoff + new_orig) AS total, runoff, new_orig, 'modelled'::text basis FROM modelled
  UNION ALL
  SELECT i, ck, pk, amt, amt, 0, basis FROM sched
), hist_span AS (
  SELECT GREATEST(1, (SELECT today FROM params) - MIN(d)) AS span_days FROM hist
), per_period AS (
  SELECT c.i, ROUND(SUM(c.total),2) total, ROUND(SUM(c.runoff),2) runoff, ROUND(SUM(c.new_orig),2) new_orig,
    ROUND(COALESCE(SUM(c.total * COALESCE(m.mape, 0.5)::numeric) FILTER (WHERE c.basis='modelled')
      / NULLIF(SUM(c.total) FILTER (WHERE c.basis='modelled'), 0), 0.5)::numeric, 4) AS wmape,
    ROUND(COALESCE(SUM(c.total) FILTER (WHERE c.basis IN ('scheduled','overdue')),0),2) AS scheduled_total,
    ROUND(COALESCE(SUM(c.total) FILTER (WHERE c.basis='overdue'),0),2) AS overdue_total,
    jsonb_agg(jsonb_build_object(
      'category_key', c.ck, 'category_label', COALESCE(lb.cl, c.ck),
      'product_key', c.pk, 'product_label', COALESCE(lb.pl, c.pk),
      'amount', ROUND(c.total,2), 'runoff', ROUND(c.runoff,2),
      'new_origination', ROUND(c.new_orig,2), 'basis', c.basis
    ) ORDER BY c.total DESC) AS sources
  FROM combined c
  LEFT JOIN model m ON m.ck=c.ck AND m.pk=c.pk
  LEFT JOIN labels lb ON lb.ck=c.ck AND lb.pk=c.pk
  GROUP BY c.i
), period_quality AS (
  SELECT pr.i, pr.period_start, pr.period_end, pp.total, pp.runoff, pp.new_orig, pp.wmape,
    pp.scheduled_total, pp.overdue_total, pp.sources, p.today, p.gran, hs.span_days,
    GREATEST(0, pr.period_end - p.today) AS horizon_days,
    CASE
      WHEN pp.total IS NULL THEN 'insufficient'
      WHEN GREATEST(0, pr.period_end - p.today) > COALESCE(hs.span_days,1) * 2
        OR (p.gran = 'year' AND pr.period_start > date_trunc('year', p.today)::date) THEN 'low'
      WHEN GREATEST(0, pr.period_end - p.today) > COALESCE(hs.span_days,1) THEN
        CASE WHEN COALESCE(pp.wmape,1) < 0.4 THEN 'medium' ELSE 'low' END
      WHEN COALESCE(pp.wmape,1) < 0.2 THEN 'high'
      WHEN COALESCE(pp.wmape,1) < 0.4 THEN 'medium'
      ELSE 'low' END AS quality,
    CASE
      WHEN pp.total IS NULL THEN 'no modelled stream has enough history for this period'
      WHEN GREATEST(0, pr.period_end - p.today) > COALESCE(hs.span_days,1) * 2
        OR (p.gran = 'year' AND pr.period_start > date_trunc('year', p.today)::date)
        THEN 'extrapolation far beyond the ' || COALESCE(hs.span_days,0) || ' days of observed payment history - treat as directional only'
      WHEN GREATEST(0, pr.period_end - p.today) > COALESCE(hs.span_days,1)
        THEN 'horizon exceeds the ' || COALESCE(hs.span_days,0) || ' days of observed payment history'
      ELSE 'within observed history span; backtest error ' || ROUND(COALESCE(pp.wmape,0.5)*100,1) || '%' END AS quality_reason
  FROM periods pr CROSS JOIN params p LEFT JOIN hist_span hs ON true
  LEFT JOIN per_period pp ON pp.i = pr.i
), periods_json AS (
  SELECT jsonb_agg(jsonb_build_object(
    'index', q.i,
    'period_start', q.period_start, 'period_end', q.period_end,
    'forecast_from', GREATEST(q.period_start, q.today),
    'is_partial_period', q.period_start < q.today,
    'label', CASE q.gran
        WHEN 'day' THEN to_char(q.period_start,'DD Mon')
        WHEN 'week' THEN 'Wk ' || to_char(q.period_start,'IW YYYY')
        WHEN 'month' THEN to_char(q.period_start,'Mon YYYY')
        WHEN 'quarter' THEN 'Q' || to_char(q.period_start,'Q YYYY')
        ELSE to_char(q.period_start,'YYYY') END,
    'forecast_amount', COALESCE(q.total,0),
    'runoff_amount', COALESCE(q.runoff,0),
    'new_origination_amount', COALESCE(q.new_orig,0),
    'scheduled_amount', COALESCE(q.scheduled_total,0),
    'overdue_carried_amount', COALESCE(q.overdue_total,0),
    'low', ROUND(COALESCE(q.total,0) * (1 - LEAST(0.6, GREATEST(0.1, COALESCE(q.wmape,0.5)))),2),
    'high', ROUND(COALESCE(q.total,0) * (1 + LEAST(0.6, GREATEST(0.1, COALESCE(q.wmape,0.5)))),2),
    'confidence', LEAST(
        CASE q.quality WHEN 'low' THEN 0.35 WHEN 'medium' THEN 0.6 WHEN 'insufficient' THEN 0.05 ELSE 0.95 END,
        ROUND(GREATEST(0.05, LEAST(0.95, (1 - COALESCE(q.wmape,0.5))
          * (1.0 / (1 + q.horizon_days::numeric / 365.0)))),3)),
    'quality', q.quality,
    'quality_reason', q.quality_reason,
    'is_forecast', true,
    'sources', COALESCE(q.sources, '[]'::jsonb),
    'landlord_float', (SELECT jsonb_build_object(
        'weeks', count(*),
        'weeks_with_float', count(lf.week_start),
        'weeks_without_float', COALESCE(jsonb_agg(g.wk::date ORDER BY g.wk) FILTER (WHERE lf.week_start IS NULL), '[]'::jsonb),
        'float_outstanding', COALESCE(sum(lf.outstanding_amount), 0),
        'landlord_not_estimated', COALESCE(bool_or(lf.week_start IS NULL), false))
      FROM generate_series(public.landlord_float_week_start(GREATEST(q.period_start, q.today)), q.period_end, interval '1 week') g(wk)
      LEFT JOIN float_payables_snap lf ON lf.week_start = g.wk::date
     WHERE (g.wk::date + 6) BETWEEN GREATEST(q.period_start, q.today) AND q.period_end)
      || jsonb_build_object('overdue_float_outstanding',
           CASE WHEN q.today BETWEEN q.period_start AND q.period_end
                THEN (SELECT COALESCE(sum(ovf.outstanding_amount), 0) FROM float_payables_snap ovf WHERE ovf.week_end < q.today)
                ELSE 0 END)
  ) ORDER BY q.i) j
  FROM period_quality q
), hist_json AS (
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'period_start')), '[]'::jsonb) j FROM (
    SELECT jsonb_build_object(
      'period_start', bucket, 'label', CASE p.gran
        WHEN 'day' THEN to_char(bucket,'DD Mon') WHEN 'week' THEN 'Wk ' || to_char(bucket,'IW YYYY')
        WHEN 'month' THEN to_char(bucket,'Mon YYYY') WHEN 'quarter' THEN 'Q' || to_char(bucket,'Q YYYY')
        ELSE to_char(bucket,'YYYY') END,
      'actual_amount', ROUND(SUM(amt),2), 'is_forecast', false) x
    FROM (
      SELECT CASE p.gran WHEN 'day' THEN h.d WHEN 'week' THEN date_trunc('week',h.d)::date
                  WHEN 'month' THEN date_trunc('month',h.d)::date
                  WHEN 'quarter' THEN date_trunc('quarter',h.d)::date
                  ELSE date_trunc('year',h.d)::date END AS bucket, h.amt
      FROM hist h CROSS JOIN params p
    ) b CROSS JOIN params p
    GROUP BY bucket, p.gran
    ORDER BY bucket DESC
    LIMIT (SELECT periods FROM params)
  ) s
), actual_json AS (
  SELECT jsonb_build_object(
    'total', ROUND(COALESCE(SUM(outstanding_amount),0),2),
    'item_count', COUNT(*),
    'overdue', ROUND(COALESCE(SUM(outstanding_amount) FILTER (WHERE due_date IS NOT NULL AND due_date < (SELECT today FROM params)),0),2),
    'not_yet_due', ROUND(COALESCE(SUM(outstanding_amount) FILTER (WHERE due_date IS NULL OR due_date >= (SELECT today FROM params)),0),2),
    'categories', COALESCE((SELECT jsonb_agg(jsonb_build_object('category_key',ck,'category_label',cl,'outstanding',amt) ORDER BY amt DESC)
       FROM (SELECT category_key ck, MAX(category_label) cl, ROUND(SUM(outstanding_amount),2) amt
             FROM payables_lines_snap GROUP BY 1) c), '[]'::jsonb)
  ) j FROM payables_lines_snap
), streams_json AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'category_key', m.ck, 'category_label', COALESCE(lb.cl, m.ck),
    'product_key', m.pk, 'product_label', COALESCE(lb.pl, m.pk),
    'method', m.method, 'sample_days', m.sample_days, 'lookback_days', m.lookback_days,
    'median_daily', ROUND(m.level::numeric,2), 'trend_per_week', ROUND((m.slope_per_day * 7)::numeric, 2),
    'backtest_mape', m.mape, 'seasonality_applied', m.method = 'seasonal_level_trend',
    'insufficient_data', m.method = 'insufficient_data',
    'outstanding', COALESCE(o.outstanding, 0),
    'origination', CASE WHEN om.ck IS NULL THEN NULL ELSE jsonb_build_object(
        'method', om.method,
        'sample_days', om.sample_days,
        'daily_new_payables', ROUND(om.level::numeric,2),
        'trend_per_week', ROUND((om.slope_per_day * 7)::numeric,2),
        'payment_rate', ROUND(om.payment_rate::numeric,4),
        'term_days', ROUND(om.term_days::numeric,0)
      ) END
  ) ORDER BY m.level DESC), '[]'::jsonb) j
  FROM model m LEFT JOIN labels lb ON lb.ck=m.ck AND lb.pk=m.pk
  LEFT JOIN outs o ON o.ck=m.ck AND o.pk=m.pk
  LEFT JOIN orig_model om ON om.ck=m.ck AND om.pk=m.pk AND om.method <> 'insufficient_data'
), no_hist AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'category_key', o.ck, 'product_key', o.pk,
    'product_label', COALESCE(lb.pl, o.pk), 'outstanding', o.outstanding,
    'reason', 'no payment history - contractual due dates only') ORDER BY o.outstanding DESC), '[]'::jsonb) j
  FROM outs o LEFT JOIN labels lb ON lb.ck=o.ck AND lb.pk=o.pk
  WHERE NOT EXISTS (SELECT 1 FROM model m WHERE m.ck=o.ck AND m.pk=o.pk AND m.method <> 'insufficient_data')
), no_orig AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'category_key', o.ck, 'product_key', o.pk,
    'product_label', COALESCE(lb.pl, o.pk), 'outstanding', o.outstanding,
    'reason', 'no obligation-creation history - existing book run-off only, no new obligations forecast'
  ) ORDER BY o.outstanding DESC), '[]'::jsonb) j
  FROM outs o LEFT JOIN labels lb ON lb.ck=o.ck AND lb.pk=o.pk
  WHERE NOT EXISTS (SELECT 1 FROM orig_model om WHERE om.ck=o.ck AND om.pk=o.pk AND om.method <> 'insufficient_data')
)
SELECT jsonb_build_object(
  'currency','UGX',
  'granularity', (SELECT gran FROM params),
  'periods_requested', (SELECT periods FROM params),
  'as_at', (SELECT today FROM params),
  'timezone','Africa/Nairobi',
  'actual', (SELECT j FROM actual_json),
  'history', (SELECT j FROM hist_json),
  'periods', COALESCE((SELECT j FROM periods_json), '[]'::jsonb),
  'streams', (SELECT j FROM streams_json),
  'scheduled_only_streams', (SELECT j FROM no_hist),
  'origination_only_streams', (SELECT j FROM no_orig),
  'meta', jsonb_build_object(
    'history_span_days', (SELECT span_days FROM hist_span),
    'lookback_days', (SELECT lookback FROM params),
    'model_version', 'payables runoff+obligations v1 (2026-08-26)',
    'method_note', 'Two components, both modelled from live history with no hardcoded growth rates. (1) Run-off of the recorded payables book: per-stream robust level (28-day median of actual payments) with weekly OLS trend, damped by holdout error and horizon distance, day-of-week seasonality when >=60 observed days, cumulatively capped at what is actually outstanding. (2) New obligations: per-stream daily new-payable level and weekly trend from the obligation tables, multiplied by the stream''s observed payment rate (paid divided by created over the same lookback) and ramped over its implied settlement term, bounded at 3x the observed level so long horizons cannot run away. Streams with contractual due dates but no payment history are carried at their scheduled amounts. Forecast quality is capped relative to the observed history span, so horizons beyond it can never read as high confidence.',
    'source', 'v_payables_lines + v_payables_payment_history + observed obligation-creation history'
  ),
  'reconciliation', (
    SELECT jsonb_build_object(
             'payables_total', x.total, 'forecast_book_runoff', x.runoff, 'of_which_overdue_carried', x.overdue,
             'modelled_not_run_off_in_horizon', x.not_run_off, 'no_due_date', x.no_due, 'due_after_horizon', x.after_h,
             'new_originations_not_in_list', x.new_orig,
             'difference', x.total - (x.runoff + x.not_run_off + x.no_due + x.after_h))
      FROM (SELECT
              (SELECT ROUND(COALESCE(SUM(outstanding_amount),0),2) FROM payables_lines_snap) AS total,
              (SELECT ROUND(COALESCE(SUM(runoff),0),2) FROM per_period) AS runoff,          -- the period totals people see
              (SELECT ROUND(COALESCE(SUM(overdue_total),0),2) FROM per_period) AS overdue,
              (SELECT ROUND(COALESCE(SUM(o.outstanding),0),2) FROM outs o
                WHERE EXISTS (SELECT 1 FROM model m WHERE m.ck=o.ck AND m.pk=o.pk AND m.method <> 'insufficient_data'))
                - (SELECT ROUND(COALESCE(SUM(c.runoff),0),2) FROM combined c WHERE c.basis = 'modelled') AS not_run_off,
              (SELECT ROUND(COALESCE(SUM(l.outstanding_amount),0),2) FROM payables_lines_snap l WHERE l.due_date IS NULL
                  AND NOT EXISTS (SELECT 1 FROM model m WHERE m.ck=l.category_key AND m.pk=l.product_key AND m.method <> 'insufficient_data')) AS no_due,
              (SELECT ROUND(COALESCE(SUM(l.outstanding_amount),0),2) FROM payables_lines_snap l WHERE l.due_date > (SELECT MAX(period_end) FROM periods)
                  AND NOT EXISTS (SELECT 1 FROM model m WHERE m.ck=l.category_key AND m.pk=l.product_key AND m.method <> 'insufficient_data')) AS after_h,
              (SELECT ROUND(COALESCE(SUM(new_orig),0),2) FROM per_period) AS new_orig) x
  ),
  'landlord_coverage', (
    SELECT jsonb_build_object(
             'basis', 'weekly_landlord_float',
             'note', 'Landlord payables are recorded per weekly landlord float set by the CFO. A week without a weekly float carries no landlord amount in this forecast: its landlord obligations are not estimated, which does not mean there are none. A float whose week has ended stays in the forecast, carried into the current period as overdue, until its payouts are verified or it is otherwise resolved. After a float''s week ends only its approved payouts not yet verified stay payable; its unused allowance lapses (lapsed_unused_float_allowance) and is never payable. Payouts approved but not yet paid out that sit in no weekly float are owed: they are carried on their own (approved_no_float_outstanding) from their approval date until paid out, including a still-funded rent request whose last payout attempt failed (a failed attempt is not a payment). Landlord payouts made without a weekly float and not verified by the Receipt Archive are held for CFO review (historical review) and are outside the payables and this forecast.',
             'weeks_in_horizon', (c.j->>'weeks')::int,
             'weeks_with_float', (c.j->>'weeks_with_float')::int,
             'weeks_without_float', c.j->'weeks_without_float',
             'landlord_not_estimated', (c.j->>'landlord_not_estimated')::boolean,
             'float_outstanding', (c.j->>'float_outstanding')::numeric,
             'historical_review_count', (SELECT count(*) FROM payout_settlement_snap WHERE state = 'historical_review'),
             'historical_review_amount', (SELECT COALESCE(sum(amount), 0) FROM payout_settlement_snap WHERE state = 'historical_review'),
             'overdue_floats', (SELECT COALESCE(jsonb_agg(jsonb_build_object('week_start', ovf.week_start, 'week_end', ovf.week_end,
                                        'outstanding', ovf.outstanding_amount, 'unverified_paid', ovf.unverified_paid) ORDER BY ovf.week_start), '[]'::jsonb)
                                  FROM float_payables_snap ovf WHERE ovf.week_end < (SELECT today FROM params) AND ovf.outstanding_amount > 0),
             'overdue_float_outstanding', (SELECT COALESCE(sum(ovf.outstanding_amount), 0) FROM float_payables_snap ovf
                                            WHERE ovf.week_end < (SELECT today FROM params)),
             'lapsed_unused_float_allowance', (SELECT COALESCE(sum(ovf.lapsed_unused), 0) FROM float_payables_snap ovf),
             'approved_no_float_count', (SELECT count(*) FROM payout_settlement_snap WHERE approved_no_float),
             'approved_no_float_outstanding', (SELECT COALESCE(sum(amount), 0) FROM payout_settlement_snap WHERE approved_no_float))
      FROM (SELECT (SELECT jsonb_build_object(
        'weeks', count(*),
        'weeks_with_float', count(lf.week_start),
        'weeks_without_float', COALESCE(jsonb_agg(g.wk::date ORDER BY g.wk) FILTER (WHERE lf.week_start IS NULL), '[]'::jsonb),
        'float_outstanding', COALESCE(sum(lf.outstanding_amount), 0),
        'landlord_not_estimated', COALESCE(bool_or(lf.week_start IS NULL), false))
      FROM generate_series(public.landlord_float_week_start((SELECT today FROM params)), (SELECT MAX(period_end) FROM periods), interval '1 week') g(wk)
      LEFT JOIN float_payables_snap lf ON lf.week_start = g.wk::date
     WHERE (g.wk::date + 6) BETWEEN (SELECT today FROM params) AND (SELECT MAX(period_end) FROM periods)) j) c
  ),
  'unscheduled', (
    SELECT jsonb_build_object(
             'items',      COALESCE(SUM(c), 0),
             'amount',     COALESCE(SUM(amt), 0),
             'by_product', COALESCE(jsonb_object_agg(product_key, amt), '{}'::jsonb),
             'note',       'Payable on demand. Included in Total Payables, excluded from the forecast timeline: no contractual due date and no daily amount to project from.')
      FROM (SELECT product_key, ROUND(SUM(outstanding_amount), 2) AS amt, COUNT(*) AS c
              FROM payables_lines_snap
             WHERE (due_kind = 'projected' AND COALESCE(daily_amount, 0) <= 0)
                OR (due_kind = 'scheduled' AND due_date IS NULL)
             GROUP BY product_key) q
  )
)
  INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_payables_predictive_forecast(text, integer, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_payables_predictive_forecast(text, integer, date) TO authenticated, postgres, service_role;
