-- Speed up get_agent_ops_overview by scanning wallet commission legs once.
--
-- The live body reads general_ledger four times for the same wallet
-- commission categories (ledger_scope = 'wallet', the six commission
-- categories, directions cash_in/credit/cash_out/debit):
--   kpis.commission_curr, kpis.commission_prev, trend.comm, top commissions.
-- At 365 days that is about 158k legs per scan, and each scan heap-fetches
-- because amount and user_id are not in the created_at indexes.
-- This is not the per-day correlated count from get_agent_active_breakdown.
-- The trend and the expected series are grouped CTEs joined onto buckets.
--
-- Read-only on byrzshwlentqvktcksem, 2026-11-04, UTC. Nothing was written.
-- The four replaced outputs (commission_curr, commission_prev, the trend
-- commission series, and the per-user narrow commission map) were identical
-- for 1, 7, 30, 90 and 365 days. At 365 days commission_prev is 0 on both
-- sides: every matching leg is inside the last 365 days (157,846 legs).
--
-- EXPLAIN (ANALYZE, BUFFERS), warm cache, shared reads 0, postgres role.
-- Full inlined body (every kpi, the trend, top performers):
--   30d  before 1,067.7 ms   four ledger scans 191.9 + 123.8 + 90.5 + 86.2 ms
--   30d  after  1,084.5 ms   one ledger scan 441.0 ms (43,714 rows)
-- The 30-day total does not drop on a quiet warm cache: the three extra
-- passes are already in shared buffers. The 365-day commission-bearing
-- slice (commission kpis, trend including the expected join, top performers)
-- does, because each pass of idx_general_ledger_created_at throws away
-- about 667,000 non-commission rows:
--   365d before 5,288.2 ms   scans 509.7 + 1,515.6 + 2,322.6 ms   758,410 hits
--   365d after    843.1 ms   one scan 561.1 ms                    265,969 hits
--
-- Signature, the now() default, RETURNS jsonb, LANGUAGE plpgsql,
-- SECURITY DEFINER, search_path and the auth/role gate stay as they are.
-- CREATE OR REPLACE keeps the current ACL. The statements below re-state it:
--   proacl = {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   anon and PUBLIC have no EXECUTE.
-- Refuses to replace the function unless prosrc md5 is still the body
-- measured above (0721afd229ef26d9c102e30b8b4e4f78). Not applied to
-- production by this change.
-- Version 20261104120000 sorts after 20261104110000 and 20261104090000.

SET lock_timeout = '5s';

DO $pre$
DECLARE
  v_md5 text;
BEGIN
  IF to_regprocedure('public.get_agent_ops_overview(timestamp with time zone, timestamp with time zone)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: public.get_agent_ops_overview(timestamp with time zone, timestamp with time zone) does not exist';
  END IF;
  SELECT md5(prosrc) INTO v_md5
  FROM pg_proc
  WHERE oid = 'public.get_agent_ops_overview(timestamp with time zone, timestamp with time zone)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '0721afd229ef26d9c102e30b8b4e4f78' THEN
    RAISE EXCEPTION 'precondition failed: get_agent_ops_overview prosrc md5 is %, expected 0721afd229ef26d9c102e30b8b4e4f78', v_md5;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.get_agent_ops_overview(p_range_start timestamp with time zone, p_range_end timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
REVOKE ALL ON FUNCTION public.get_agent_ops_overview(timestamp with time zone, timestamp with time zone) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_agent_ops_overview(timestamp with time zone, timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_ops_overview(timestamp with time zone, timestamp with time zone) TO service_role;
