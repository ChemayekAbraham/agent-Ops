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

  WITH RECURSIVE
  base_ts AS (
    SELECT rr.agent_id AS uid, MIN(rr.created_at) AS ts FROM rent_requests rr
      WHERE rr.agent_id IS NOT NULL AND rr.tenant_id IS NOT NULL AND rr.agent_id <> rr.tenant_id
      GROUP BY rr.agent_id
    UNION ALL
    SELECT ac.agent_id, MIN(ac.created_at) FROM agent_collections ac
      WHERE ac.agent_id IS NOT NULL GROUP BY ac.agent_id
    UNION ALL
    SELECT hl.agent_id, MIN(hl.created_at) FROM house_listings hl
      WHERE hl.agent_id IS NOT NULL GROUP BY hl.agent_id
    UNION ALL
    SELECT pn.agent_id, MIN(pn.created_at) FROM promissory_notes pn
      WHERE pn.agent_id IS NOT NULL GROUP BY pn.agent_id
  ),
  base_min AS (
    SELECT uid, MIN(ts) AS ts FROM base_ts GROUP BY uid
  ),
  edges AS (
    SELECT s.parent_agent_id AS parent, s.sub_agent_id AS child
      FROM agent_subagents s
      WHERE s.parent_agent_id IS NOT NULL AND s.sub_agent_id IS NOT NULL
  ),
  propagated AS (
    SELECT uid, ts FROM base_min
    UNION
    SELECT e.parent, p.ts FROM edges e JOIN propagated p ON p.uid = e.child
  )
  INSERT INTO tmp_qual (agent_id, first_ts)
  SELECT uid, MIN(ts) FROM propagated WHERE uid IS NOT NULL GROUP BY uid;

  -- Sub-agent set (earliest link per sub-agent)
  CREATE TEMP TABLE tmp_sub (sub_agent_id uuid PRIMARY KEY, first_ts timestamptz NOT NULL) ON COMMIT DROP;
  INSERT INTO tmp_sub (sub_agent_id, first_ts)
  SELECT sub_agent_id, MIN(created_at)
    FROM agent_subagents
    WHERE sub_agent_id IS NOT NULL
    GROUP BY sub_agent_id;

  WITH
  active_curr AS (
    SELECT DISTINCT agent_id AS uid FROM rent_requests
      WHERE agent_id IS NOT NULL AND created_at >= p_range_start AND created_at < p_range_end
    UNION SELECT DISTINCT agent_id FROM agent_collections
      WHERE agent_id IS NOT NULL AND created_at >= p_range_start AND created_at < p_range_end
    UNION SELECT DISTINCT agent_id FROM agent_visits
      WHERE agent_id IS NOT NULL AND created_at >= p_range_start AND created_at < p_range_end
  ),
  active_prev AS (
    SELECT DISTINCT agent_id AS uid FROM rent_requests
      WHERE agent_id IS NOT NULL AND created_at >= v_prev_start AND created_at < v_prev_end
    UNION SELECT DISTINCT agent_id FROM agent_collections
      WHERE agent_id IS NOT NULL AND created_at >= v_prev_start AND created_at < v_prev_end
    UNION SELECT DISTINCT agent_id FROM agent_visits
      WHERE agent_id IS NOT NULL AND created_at >= v_prev_start AND created_at < v_prev_end
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
    'collections_today',        (SELECT COALESCE(sum(amount),0) FROM agent_collections WHERE created_at::date = v_today),
    'collections_today_count',  (SELECT count(*) FROM agent_collections WHERE created_at::date = v_today),
    'collections_curr',         (SELECT COALESCE(sum(amount),0) FROM agent_collections WHERE created_at >= p_range_start AND created_at < p_range_end),
    'collections_prev',         (SELECT COALESCE(sum(amount),0) FROM agent_collections WHERE created_at >= v_prev_start AND created_at < v_prev_end),
    'collections_count_curr',   (SELECT count(*) FROM agent_collections WHERE created_at >= p_range_start AND created_at < p_range_end),
    'collections_count_prev',   (SELECT count(*) FROM agent_collections WHERE created_at >= v_prev_start AND created_at < v_prev_end),
    'pending_collections',      (SELECT COALESCE(sum(GREATEST(COALESCE(total_repayment,0) - COALESCE(amount_repaid,0), 0)),0)
                                   FROM rent_requests
                                   WHERE status IN ('funded','repaying','disbursed','active')
                                     AND COALESCE(tenancy_status,'active') <> 'ended'),
    'commission_curr',          (SELECT COALESCE(sum(amount),0) FROM general_ledger
                                  WHERE ledger_scope='wallet' AND direction IN ('cash_in','credit')
                                    AND category IN ('agent_commission_earned','agent_commission','agent_bonus','agent_investment_commission','proxy_investment_commission','partner_commission')
                                    AND created_at >= p_range_start AND created_at < p_range_end),
    'commission_prev',          (SELECT COALESCE(sum(amount),0) FROM general_ledger
                                  WHERE ledger_scope='wallet' AND direction IN ('cash_in','credit')
                                    AND category IN ('agent_commission_earned','agent_commission','agent_bonus','agent_investment_commission','proxy_investment_commission','partner_commission')
                                    AND created_at >= v_prev_start AND created_at < v_prev_end),
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
      FROM agent_collections WHERE created_at >= p_range_start AND created_at < p_range_end GROUP BY 1
  ),
  comm AS (
    SELECT date_trunc(v_bucket_fmt, created_at) AS ts, COALESCE(sum(amount),0) AS n
      FROM general_ledger
      WHERE ledger_scope='wallet' AND direction IN ('cash_in','credit')
        AND category IN ('agent_commission_earned','agent_commission','agent_bonus','agent_investment_commission','proxy_investment_commission','partner_commission')
        AND created_at >= p_range_start AND created_at < p_range_end
      GROUP BY 1
  ),
  active_bkt AS (
    SELECT ts, count(DISTINCT uid) AS n FROM (
      SELECT date_trunc(v_bucket_fmt, created_at) AS ts, agent_id AS uid FROM rent_requests
        WHERE agent_id IS NOT NULL AND created_at >= p_range_start AND created_at < p_range_end
      UNION SELECT date_trunc(v_bucket_fmt, created_at), agent_id FROM agent_collections
        WHERE agent_id IS NOT NULL AND created_at >= p_range_start AND created_at < p_range_end
      UNION SELECT date_trunc(v_bucket_fmt, created_at), agent_id FROM agent_visits
        WHERE agent_id IS NOT NULL AND created_at >= p_range_start AND created_at < p_range_end
    ) s
    WHERE uid IN (SELECT agent_id FROM tmp_qual WHERE first_ts < p_range_end)
    GROUP BY ts
  ),
  -- Expected repayment due inside each bucket, for loans already live at that point
  expected AS (
    SELECT b.ts,
           COALESCE(sum(rr.daily_repayment) * (CASE WHEN v_bucket_fmt = 'hour' THEN 1.0/24.0 ELSE 1.0 END), 0) AS n
      FROM buckets b
      LEFT JOIN rent_requests rr
        ON rr.status IN ('funded','repaying','disbursed','active')
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

  -- ============ Top performers (agents + sub-agents) ============
  WITH collected AS (
    SELECT agent_id AS uid,
           COALESCE(sum(amount),0) AS collected,
           count(*) AS collections
      FROM agent_collections
     WHERE agent_id IS NOT NULL
       AND created_at >= p_range_start AND created_at < p_range_end
     GROUP BY agent_id
  ),
  commissions AS (
    SELECT user_id AS uid, COALESCE(sum(amount),0) AS commission
      FROM general_ledger
     WHERE ledger_scope='wallet' AND direction IN ('cash_in','credit')
       AND category IN ('agent_commission_earned','agent_commission','agent_bonus')
       AND created_at >= p_range_start AND created_at < p_range_end
     GROUP BY user_id
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