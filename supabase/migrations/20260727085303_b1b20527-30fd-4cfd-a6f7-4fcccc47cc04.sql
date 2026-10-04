CREATE OR REPLACE FUNCTION public.get_agent_ops_overview(
  p_range_start timestamptz,
  p_range_end timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  IF v_days <= 1 THEN
    v_bucket := 'hour'; v_bucket_fmt := 'hour';
  ELSE
    v_bucket := 'day'; v_bucket_fmt := 'day';
  END IF;

  -- ============ KPIs ============
  WITH
  active_curr AS (
    SELECT DISTINCT agent_id AS uid FROM rent_requests
      WHERE agent_id IS NOT NULL AND created_at >= p_range_start AND created_at < p_range_end
    UNION
    SELECT DISTINCT agent_id FROM agent_collections
      WHERE agent_id IS NOT NULL AND created_at >= p_range_start AND created_at < p_range_end
    UNION
    SELECT DISTINCT agent_id FROM agent_visits
      WHERE agent_id IS NOT NULL AND created_at >= p_range_start AND created_at < p_range_end
  ),
  active_prev AS (
    SELECT DISTINCT agent_id AS uid FROM rent_requests
      WHERE agent_id IS NOT NULL AND created_at >= v_prev_start AND created_at < v_prev_end
    UNION
    SELECT DISTINCT agent_id FROM agent_collections
      WHERE agent_id IS NOT NULL AND created_at >= v_prev_start AND created_at < v_prev_end
    UNION
    SELECT DISTINCT agent_id FROM agent_visits
      WHERE agent_id IS NOT NULL AND created_at >= v_prev_start AND created_at < v_prev_end
  )
  SELECT jsonb_build_object(
    'total_users',         (SELECT count(*) FROM profiles),
    'total_agents',        (SELECT count(*) FROM user_roles WHERE role = 'agent'),
    'active_agents_curr',  (SELECT count(*) FROM active_curr),
    'active_agents_prev',  (SELECT count(*) FROM active_prev),
    'new_agents_curr',     (SELECT count(*) FROM user_roles WHERE role='agent' AND created_at >= p_range_start AND created_at < p_range_end),
    'new_agents_prev',     (SELECT count(*) FROM user_roles WHERE role='agent' AND created_at >= v_prev_start AND created_at < v_prev_end),
    'rent_req_curr',       (SELECT count(*) FROM rent_requests WHERE created_at >= p_range_start AND created_at < p_range_end),
    'rent_req_prev',       (SELECT count(*) FROM rent_requests WHERE created_at >= v_prev_start AND created_at < v_prev_end),
    'rent_req_amount_curr',(SELECT COALESCE(sum(rent_amount),0) FROM rent_requests WHERE created_at >= p_range_start AND created_at < p_range_end),
    'verified_houses_curr',(SELECT count(*) FROM house_listings WHERE verified = true AND verified_at >= p_range_start AND verified_at < p_range_end),
    'verified_houses_prev',(SELECT count(*) FROM house_listings WHERE verified = true AND verified_at >= v_prev_start AND verified_at < v_prev_end),
    'collections_today',   (SELECT COALESCE(sum(amount),0) FROM agent_collections WHERE created_at::date = v_today),
    'collections_today_count', (SELECT count(*) FROM agent_collections WHERE created_at::date = v_today),
    'collections_curr',    (SELECT COALESCE(sum(amount),0) FROM agent_collections WHERE created_at >= p_range_start AND created_at < p_range_end),
    'collections_prev',    (SELECT COALESCE(sum(amount),0) FROM agent_collections WHERE created_at >= v_prev_start AND created_at < v_prev_end),
    'commission_curr',     (SELECT COALESCE(sum(amount),0) FROM general_ledger
                              WHERE ledger_scope='wallet' AND direction IN ('cash_in','credit')
                                AND category IN ('agent_commission_earned','agent_commission','agent_bonus','agent_investment_commission','proxy_investment_commission','partner_commission')
                                AND created_at >= p_range_start AND created_at < p_range_end),
    'commission_prev',     (SELECT COALESCE(sum(amount),0) FROM general_ledger
                              WHERE ledger_scope='wallet' AND direction IN ('cash_in','credit')
                                AND category IN ('agent_commission_earned','agent_commission','agent_bonus','agent_investment_commission','proxy_investment_commission','partner_commission')
                                AND created_at >= v_prev_start AND created_at < v_prev_end),
    'outstanding_advances',   (SELECT COALESCE(sum(outstanding_balance),0) FROM agent_advances WHERE status IN ('active','disbursed','overdue')),
    'active_advances_count',  (SELECT count(*) FROM agent_advances WHERE status IN ('active','disbursed','overdue')),
    'behind_advances_count',  (SELECT count(*) FROM agent_advances WHERE status IN ('active','disbursed','overdue') AND COALESCE(arrears_balance,0) > 0),
    'arrears_total',          (SELECT COALESCE(sum(arrears_balance),0) FROM agent_advances WHERE status IN ('active','disbursed','overdue')),
    'pending_advance_requests', (SELECT count(*) FROM agent_advance_requests WHERE status = 'pending'),
    'rent_pending',   (SELECT count(*) FROM rent_requests WHERE status='pending'  AND created_at >= p_range_start AND created_at < p_range_end),
    'rent_approved',  (SELECT count(*) FROM rent_requests WHERE status IN ('approved','disbursed','funded') AND created_at >= p_range_start AND created_at < p_range_end),
    'rent_repaying',  (SELECT count(*) FROM rent_requests WHERE status='repaying' AND created_at >= p_range_start AND created_at < p_range_end),
    'rent_rejected',  (SELECT count(*) FROM rent_requests WHERE status IN ('rejected','deleted_by_agent') AND created_at >= p_range_start AND created_at < p_range_end)
  ) INTO v_kpis;

  -- ============ Listings funnel (current range) ============
  SELECT jsonb_build_object(
    'listed',   (SELECT count(*) FROM house_listings WHERE created_at >= p_range_start AND created_at < p_range_end),
    'verified', (SELECT count(*) FROM house_listings WHERE created_at >= p_range_start AND created_at < p_range_end AND verified = true),
    'placed',   (SELECT count(*) FROM house_listings WHERE created_at >= p_range_start AND created_at < p_range_end AND tenant_id IS NOT NULL)
  ) INTO v_funnel;

  -- ============ Trend series ============
  WITH buckets AS (
    SELECT generate_series(
      date_trunc(v_bucket_fmt, p_range_start),
      date_trunc(v_bucket_fmt, p_range_end - interval '1 second'),
      (('1 ' || v_bucket_fmt))::interval
    ) AS ts
  ),
  new_agents AS (
    SELECT date_trunc(v_bucket_fmt, created_at) AS ts, count(*) AS n
      FROM user_roles WHERE role='agent' AND created_at >= p_range_start AND created_at < p_range_end GROUP BY 1
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
      UNION
      SELECT date_trunc(v_bucket_fmt, created_at), agent_id FROM agent_collections
        WHERE agent_id IS NOT NULL AND created_at >= p_range_start AND created_at < p_range_end
      UNION
      SELECT date_trunc(v_bucket_fmt, created_at), agent_id FROM agent_visits
        WHERE agent_id IS NOT NULL AND created_at >= p_range_start AND created_at < p_range_end
    ) s GROUP BY ts
  )
  SELECT jsonb_agg(jsonb_build_object(
    'day', b.ts,
    'agents',       COALESCE(na.n, 0),
    'active_agents',COALESCE(ab.n, 0),
    'requests',     COALESCE(rq.n, 0),
    'collections',  COALESCE(cl.n, 0),
    'commission',   COALESCE(cm.n, 0)
  ) ORDER BY b.ts)
  INTO v_trend
  FROM buckets b
    LEFT JOIN new_agents na  ON na.ts = b.ts
    LEFT JOIN reqs rq        ON rq.ts = b.ts
    LEFT JOIN cols cl        ON cl.ts = b.ts
    LEFT JOIN comm cm        ON cm.ts = b.ts
    LEFT JOIN active_bkt ab  ON ab.ts = b.ts;

  RETURN jsonb_build_object(
    'range', jsonb_build_object('start', p_range_start, 'end', p_range_end),
    'kpis', v_kpis,
    'listings_funnel', v_funnel,
    'trend', COALESCE(v_trend, '[]'::jsonb),
    'generated_at', now()
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_agent_ops_overview(timestamptz, timestamptz) TO authenticated;