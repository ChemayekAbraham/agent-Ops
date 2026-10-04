CREATE OR REPLACE FUNCTION public.agent_ops_strict_agent_ids()
 RETURNS TABLE(agent_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- Baseline definition (2026-09-02): an agent is anyone who has collected rent
  -- (agent_collections) or acted as the agent on a rent request of any status.
  -- Self-requests (acting agent = tenant) are excluded. House listings alone no
  -- longer qualify a user as an agent.
  SELECT DISTINCT uid FROM (
    SELECT ac.agent_id AS uid FROM agent_collections ac WHERE ac.agent_id IS NOT NULL
    UNION
    SELECT COALESCE(rr.assigned_agent_id, rr.agent_id) AS uid
      FROM rent_requests rr
     WHERE COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL
       AND rr.tenant_id IS NOT NULL
       AND COALESCE(rr.assigned_agent_id, rr.agent_id) <> rr.tenant_id
  ) q
  WHERE uid IS NOT NULL;
$function$;

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

  WITH
  -- Active = collected rent in the window (agent_collections only, baseline rule)
  active_curr AS (
    SELECT DISTINCT agent_id AS uid FROM agent_collections
      WHERE agent_id IS NOT NULL AND created_at >= p_range_start AND created_at < p_range_end
  ),
  active_prev AS (
    SELECT DISTINCT agent_id AS uid FROM agent_collections
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
      SELECT date_trunc(v_bucket_fmt, created_at) AS ts, agent_id AS uid FROM agent_collections
        WHERE agent_id IS NOT NULL AND created_at >= p_range_start AND created_at < p_range_end
    ) s
    WHERE uid IN (SELECT agent_id FROM tmp_qual WHERE first_ts < p_range_end)
    GROUP BY ts
  ),
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

CREATE OR REPLACE FUNCTION public.get_agent_directory_v2(p_search text DEFAULT NULL::text, p_type text DEFAULT 'all'::text, p_status text DEFAULT 'all'::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_limit int := GREATEST(1, LEAST(100, COALESCE(p_limit,50)));
  v_offset int := GREATEST(0, COALESCE(p_offset,0));
  v_q text := NULLIF(btrim(COALESCE(p_search,'')),'');
BEGIN
  PERFORM public.agent_ops_directory_guard();

  RETURN (
    WITH universe AS (
      SELECT agent_id AS uid FROM public.agent_ops_strict_agent_ids()
    ),
    subs AS (
      SELECT DISTINCT sa.sub_agent_id AS uid FROM agent_subagents sa
       WHERE sa.sub_agent_id IS NOT NULL
    ),
    tenant_counts AS (
      SELECT rr.agent_id AS uid, count(DISTINCT rr.tenant_id) AS n
        FROM rent_requests rr
        JOIN universe u ON u.uid = rr.agent_id
       WHERE rr.tenant_id IS NOT NULL AND rr.tenant_id <> rr.agent_id
       GROUP BY rr.agent_id
    ),
    enriched AS (
      SELECT
        u.uid,
        p.full_name, p.phone, p.email, p.avatar_url, p.verified, p.territory,
        COALESCE(dd.region, public.ug_canonical_region(p.region), 'Unassigned') AS region,
        COALESCE(dd.name, 'Unassigned') AS district,
        p.created_at, p.last_active_at, p.is_frozen,
        p.agent_tier,
        CASE WHEN s.uid IS NOT NULL THEN 'sub_agent' ELSE 'agent' END AS agent_kind,
        COALESCE(tc.n, 0)::int AS total_tenants,
        CASE
          WHEN p.is_frozen THEN 'frozen'
          WHEN p.last_active_at IS NOT NULL AND p.last_active_at >= now() - interval '30 days' THEN 'active'
          ELSE 'inactive'
        END AS status
      FROM universe u
      JOIN profiles p ON p.id = u.uid
      LEFT JOIN ug_districts dd ON dd.id = p.district_id
      LEFT JOIN subs s ON s.uid = u.uid
      LEFT JOIN tenant_counts tc ON tc.uid = u.uid
    ),
    kpi AS (
      -- Baseline 2026-09-02: total agents = collections UNION non-self rent requests;
      -- active agents = distinct agent_id in agent_collections;
      -- sub-agents counted separately from agent_subagents (never added to agents).
      SELECT
        (SELECT count(*)::int FROM universe) AS total_agents,
        (SELECT count(DISTINCT sa.sub_agent_id)::int FROM agent_subagents sa WHERE sa.sub_agent_id IS NOT NULL) AS total_sub_agents,
        (SELECT count(DISTINCT ac.agent_id)::int FROM agent_collections ac WHERE ac.agent_id IS NOT NULL) AS total_active,
        (SELECT count(*)::int FROM universe) AS total_all
    ),
    filtered AS (
      SELECT * FROM enriched e
      WHERE (COALESCE(p_type,'all') = 'all' OR e.agent_kind = p_type)
        AND (COALESCE(p_status,'all') = 'all' OR e.status = p_status)
        AND (
          v_q IS NULL
          OR e.full_name ILIKE '%'||v_q||'%'
          OR e.phone ILIKE '%'||v_q||'%'
          OR e.email ILIKE '%'||v_q||'%'
          OR e.territory ILIKE '%'||v_q||'%'
          OR e.district ILIKE '%'||v_q||'%'
          OR e.region ILIKE '%'||v_q||'%'
          OR e.uid::text = v_q
        )
    ),
    page AS (
      SELECT * FROM filtered
      ORDER BY total_tenants DESC, full_name ASC NULLS LAST
      LIMIT v_limit OFFSET v_offset
    ),
    page_metrics AS (
      SELECT
        pg.*,
        (SELECT count(*)::int FROM agent_subagents s WHERE s.parent_agent_id = pg.uid) AS sub_agents_count,
        (SELECT count(*)::int FROM house_listings hl WHERE hl.agent_id = pg.uid) AS houses_listed,
        COALESCE((
          SELECT sum(rr.daily_repayment) FROM rent_requests rr
           WHERE rr.agent_id = pg.uid
             AND rr.status IN ('funded','repaying')
             AND COALESCE(rr.amount_repaid,0) < COALESCE(rr.total_repayment,0)
             AND COALESCE(rr.agent_payment_status,'') <> 'not_paying'
        ),0) AS daily_target,
        COALESCE((
          SELECT GREATEST(0, sum(COALESCE(rr.total_repayment,0)) - sum(COALESCE(rr.amount_repaid,0)))
            FROM rent_requests rr
           WHERE rr.agent_id = pg.uid AND rr.status IN ('funded','repaying')
        ),0) AS outstanding,
        COALESCE((
          SELECT sum(ac.amount) FROM agent_collections ac
           WHERE ac.agent_id = pg.uid AND ac.created_at >= date_trunc('day', now())
        ),0) AS collected_today,
        (SELECT max(ac.created_at) FROM agent_collections ac WHERE ac.agent_id = pg.uid) AS last_collection_at
      FROM page pg
    )
    SELECT jsonb_build_object(
      'kpis', (SELECT to_jsonb(k) FROM kpi k),
      'total_matched', (SELECT count(*)::int FROM filtered),
      'limit', v_limit,
      'offset', v_offset,
      'rows', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', pm.uid,
          'full_name', pm.full_name,
          'phone', pm.phone,
          'email', pm.email,
          'avatar_url', pm.avatar_url,
          'verified', COALESCE(pm.verified,false),
          'territory', pm.territory,
          'region', pm.region,
          'district', pm.district,
          'agent_tier', pm.agent_tier,
          'created_at', pm.created_at,
          'last_active_at', pm.last_active_at,
          'agent_kind', pm.agent_kind,
          'total_tenants', pm.total_tenants,
          'sub_agents_count', pm.sub_agents_count,
          'houses_listed', pm.houses_listed,
          'daily_target', pm.daily_target,
          'collected_today', pm.collected_today,
          'outstanding', pm.outstanding,
          'last_collection_at', pm.last_collection_at,
          'status', pm.status
        ) ORDER BY pm.total_tenants DESC, pm.full_name ASC NULLS LAST)
        FROM page_metrics pm
      ), '[]'::jsonb)
    )
  );
END;
$function$;