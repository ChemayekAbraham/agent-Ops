
CREATE OR REPLACE FUNCTION public.agent_ops_report_expected(p_from date, p_to date)
RETURNS TABLE(agent_id uuid, expected numeric, tenants integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH today AS (SELECT (now() AT TIME ZONE 'Africa/Kampala')::date AS d),
  hist AS (
    SELECT h.agent_id, h.day, h.expected_daily, h.active_count
    FROM public.agent_daily_eligibility_history h
    WHERE h.day BETWEEN p_from AND p_to
  ),
  live AS (
    SELECT v.agent_id, t.d AS day, v.expected_daily, v.active_count
    FROM public.v_agent_daily_eligibility v CROSS JOIN today t
    WHERE t.d BETWEEN p_from AND p_to
      AND NOT EXISTS (SELECT 1 FROM hist h WHERE h.agent_id = v.agent_id AND h.day = t.d)
  ),
  all_days AS (SELECT * FROM hist UNION ALL SELECT * FROM live)
  SELECT a.agent_id,
         COALESCE(SUM(a.expected_daily),0)::numeric AS expected,
         COALESCE(MAX(a.active_count),0)::int AS tenants
  FROM all_days a
  GROUP BY a.agent_id;
$$;

GRANT EXECUTE ON FUNCTION public.agent_ops_report_expected(date,date) TO authenticated;

-- ---- rent collections: expected from eligibility snapshots ----
CREATE OR REPLACE FUNCTION public.agent_ops_report_rent_collections(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_rows jsonb; v_sum record;
BEGIN
  IF NOT public.agent_ops_report_authorized() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF p_from IS NULL OR p_to IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;

  WITH exp AS (
    SELECT e.agent_id, e.expected, e.tenants FROM public.agent_ops_report_expected(p_from, p_to) e
  ), got AS (
    SELECT ac.agent_id,
           SUM(ac.amount) AS collected,
           COUNT(*) AS payments,
           COUNT(DISTINCT COALESCE(ac.rent_request_id, ac.tenant_id)) AS paid_tenants
    FROM public.agent_collections ac
    WHERE ac.amount > 0
      AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
    GROUP BY ac.agent_id
  ), merged AS (
    SELECT COALESCE(e.agent_id, g.agent_id) AS agent_id,
           COALESCE(e.expected,0) AS expected,
           COALESCE(e.tenants,0) AS repaying_tenants,
           COALESCE(g.collected,0) AS collected,
           COALESCE(g.payments,0) AS payments,
           COALESCE(g.paid_tenants,0) AS paid_tenants
    FROM exp e FULL OUTER JOIN got g ON g.agent_id = e.agent_id
    WHERE COALESCE(e.agent_id, g.agent_id) IS NOT NULL
  ), scored AS (
    SELECT m.*, p.full_name, p.phone,
           CASE WHEN m.expected > 0 THEN ROUND(m.collected*100.0/m.expected,1) END AS rate
    FROM merged m LEFT JOIN public.profiles p ON p.id = m.agent_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'agent_id', s.agent_id,
           'full_name', s.full_name,
           'phone', s.phone,
           'repaying_tenants', s.repaying_tenants,
           'expected', s.expected,
           'collected', s.collected,
           'payments', s.payments,
           'paid_tenants', s.paid_tenants,
           'rate', s.rate,
           'status', CASE
             WHEN s.collected <= 0 THEN 'Silent'
             WHEN s.rate IS NULL THEN 'Unscheduled'
             WHEN s.rate >= 100 THEN 'Excellent'
             WHEN s.rate >= 75 THEN 'On track'
             WHEN s.rate >= 50 THEN 'Fair'
             ELSE 'Behind' END
         ) ORDER BY s.collected DESC NULLS LAST), '[]'::jsonb)
    INTO v_rows
  FROM scored s;

  SELECT
    (SELECT COUNT(*) FROM public.agent_ops_report_expected(p_from, p_to)) AS total_agents,
    (SELECT COUNT(DISTINCT ac.agent_id) FROM public.agent_collections ac WHERE ac.amount > 0 AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to) AS active_agents,
    (SELECT COALESCE(SUM(e.expected),0) FROM public.agent_ops_report_expected(p_from, p_to) e) AS expected,
    (SELECT COALESCE(SUM(ac.amount),0) FROM public.agent_collections ac WHERE ac.amount > 0 AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to) AS collected,
    (SELECT COALESCE(SUM(e.tenants),0) FROM public.agent_ops_report_expected(p_from, p_to) e) AS repaying_tenants
  INTO v_sum;

  RETURN jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'kpis', jsonb_build_object(
      'total_agents', v_sum.total_agents,
      'active_agents', v_sum.active_agents,
      'expected', v_sum.expected,
      'collected', v_sum.collected,
      'repaying_tenants', v_sum.repaying_tenants,
      'collection_rate', CASE WHEN v_sum.expected > 0 THEN ROUND(v_sum.collected*100.0/v_sum.expected,1) END
    ),
    'rows', v_rows
  );
END;
$$;

-- ---- agent report: expected window + per-day series from snapshots ----
CREATE OR REPLACE FUNCTION public.agent_ops_report_agent(p_agent_id uuid, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_agent jsonb; v_tenants jsonb; v_periods jsonb; v_k record; v_expected numeric;
BEGIN
  IF NOT public.agent_ops_report_authorized() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF p_agent_id IS NULL OR p_from IS NULL OR p_to IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;

  SELECT jsonb_build_object('agent_id', p.id, 'full_name', p.full_name, 'phone', p.phone,
                            'territory', p.territory)
    INTO v_agent
  FROM public.profiles p WHERE p.id = p_agent_id;

  WITH plans AS (
    SELECT rr.id, rr.tenant_id, rr.rent_amount, rr.total_repayment, rr.daily_repayment,
           COALESCE(rr.amount_repaid,0) AS amount_repaid, rr.status
    FROM public.rent_requests rr
    WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id)
      AND rr.status IN ('funded','repaying','completed')
  ), coll AS (
    SELECT ac.rent_request_id,
           SUM(ac.amount) AS collected_window,
           COUNT(*) AS payments,
           MAX(ac.created_at) AS last_at
    FROM public.agent_collections ac
    WHERE ac.amount > 0
      AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
      AND ac.rent_request_id IN (SELECT id FROM plans)
    GROUP BY ac.rent_request_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'rent_request_id', x.id,
           'tenant_name', x.tenant_name,
           'tenant_phone', x.tenant_phone,
           'rent_amount', x.rent_amount,
           'outstanding', x.outstanding,
           'repayment', x.total_repayment,
           'collected', x.collected_window,
           'collected_to_date', x.amount_repaid,
           'payments', x.payments,
           'percentage', x.percentage,
           'last_collection_at', x.last_at,
           'status', x.status
         ) ORDER BY x.collected_window DESC NULLS LAST, x.tenant_name), '[]'::jsonb)
    INTO v_tenants
  FROM (
    SELECT pl.id, pl.rent_amount, pl.total_repayment, pl.amount_repaid, pl.status,
           tp.full_name AS tenant_name, tp.phone AS tenant_phone,
           GREATEST(COALESCE(pl.total_repayment,0) - pl.amount_repaid, 0) AS outstanding,
           COALESCE(c.collected_window,0) AS collected_window,
           COALESCE(c.payments,0) AS payments,
           c.last_at,
           CASE WHEN COALESCE(pl.total_repayment,0) > 0
                THEN ROUND(pl.amount_repaid * 100.0 / pl.total_repayment, 1) ELSE NULL END AS percentage
    FROM plans pl
    LEFT JOIN public.profiles tp ON tp.id = pl.tenant_id
    LEFT JOIN coll c ON c.rent_request_id = pl.id
    WHERE pl.status IN ('funded','repaying') OR c.rent_request_id IS NOT NULL
  ) x;

  WITH days AS (SELECT d::date AS day FROM generate_series(p_from, p_to, interval '1 day') d),
  exp AS (
    SELECT h.day, SUM(h.expected_daily) AS expected
    FROM public.agent_daily_eligibility_history h
    WHERE h.agent_id = p_agent_id AND h.day BETWEEN p_from AND p_to
    GROUP BY h.day
  ), got AS (
    SELECT (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS day,
           SUM(ac.amount) AS collected, COUNT(*) AS payments
    FROM public.agent_collections ac
    WHERE ac.agent_id = p_agent_id AND ac.amount > 0
      AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
    GROUP BY 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'period', to_char(d.day,'YYYY-MM-DD'),
           'expected', COALESCE(e.expected,0),
           'collected', COALESCE(g.collected,0),
           'payments', COALESCE(g.payments,0),
           'shortfall', GREATEST(COALESCE(e.expected,0) - COALESCE(g.collected,0), 0),
           'rate', CASE WHEN COALESCE(e.expected,0) > 0
                        THEN ROUND(COALESCE(g.collected,0) * 100.0 / e.expected, 1) ELSE NULL END
         ) ORDER BY d.day), '[]'::jsonb)
    INTO v_periods
  FROM days d
  LEFT JOIN exp e ON e.day = d.day
  LEFT JOIN got g ON g.day = d.day;

  SELECT COALESCE(SUM(e.expected),0) INTO v_expected
  FROM public.agent_ops_report_expected(p_from, p_to) e WHERE e.agent_id = p_agent_id;

  SELECT
    (SELECT COUNT(*) FROM public.rent_requests rr WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id) AND rr.status IN ('funded','repaying','completed')) AS assigned_tenants,
    (SELECT COUNT(*) FROM public.rent_requests rr WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id) AND rr.status IN ('funded','repaying')) AS active_repaying,
    (SELECT COALESCE(SUM(rr.rent_amount),0) FROM public.rent_requests rr WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id) AND rr.status IN ('funded','repaying','completed')) AS rent_total,
    (SELECT COALESCE(SUM(rr.total_repayment),0) FROM public.rent_requests rr WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id) AND rr.status IN ('funded','repaying','completed')) AS repayment_total,
    (SELECT COALESCE(SUM(rr.amount_repaid),0) FROM public.rent_requests rr WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id) AND rr.status IN ('funded','repaying','completed')) AS repaid_total,
    (SELECT COALESCE(SUM(ac.amount),0) FROM public.agent_collections ac WHERE ac.agent_id = p_agent_id AND ac.amount > 0 AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to) AS collected_window,
    (SELECT COUNT(*) FROM public.agent_collections ac WHERE ac.agent_id = p_agent_id AND ac.amount > 0 AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to) AS payments_window
  INTO v_k;

  RETURN jsonb_build_object(
    'agent', COALESCE(v_agent,'{}'::jsonb),
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'kpis', jsonb_build_object(
      'assigned_tenants', v_k.assigned_tenants,
      'active_repaying', v_k.active_repaying,
      'rent_total', v_k.rent_total,
      'repayment_total', v_k.repayment_total,
      'collected_to_date', v_k.repaid_total,
      'outstanding', GREATEST(v_k.repayment_total - v_k.repaid_total, 0),
      'expected_window', v_expected,
      'collected_window', v_k.collected_window,
      'payments_window', v_k.payments_window,
      'repayment_rate', CASE WHEN v_k.repayment_total > 0 THEN ROUND(v_k.repaid_total*100.0/v_k.repayment_total,1) END,
      'window_rate', CASE WHEN v_expected > 0 THEN ROUND(v_k.collected_window*100.0/v_expected,1) END
    ),
    'tenants', v_tenants,
    'periods', v_periods
  );
END;
$$;

-- ---- team collections: expected from snapshots, rank across teams ----
CREATE OR REPLACE FUNCTION public.agent_ops_report_team_collections(p_parent_agent_id uuid, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_leader jsonb; v_rows jsonb; v_sum record; v_rank record;
BEGIN
  IF NOT public.agent_ops_report_authorized() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF p_parent_agent_id IS NULL OR p_from IS NULL OR p_to IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;

  SELECT jsonb_build_object('parent_agent_id', p.id, 'full_name', p.full_name, 'phone', p.phone)
    INTO v_leader FROM public.profiles p WHERE p.id = p_parent_agent_id;

  WITH members AS (
    SELECT DISTINCT h.member_agent_id AS agent_id
    FROM public.agent_team_membership_history h
    WHERE h.parent_agent_id = p_parent_agent_id
      AND h.valid_from::date <= p_to
      AND (h.valid_to IS NULL OR h.valid_to::date >= p_from)
    UNION
    SELECT p_parent_agent_id
  ), exp AS (
    SELECT e.agent_id, e.expected, e.tenants
    FROM public.agent_ops_report_expected(p_from, p_to) e
    WHERE e.agent_id IN (SELECT agent_id FROM members)
  ), got AS (
    SELECT ac.agent_id, SUM(ac.amount) AS collected, COUNT(*) AS payments, MAX(ac.created_at) AS last_at
    FROM public.agent_collections ac
    WHERE ac.amount > 0
      AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
      AND ac.agent_id IN (SELECT agent_id FROM members)
    GROUP BY ac.agent_id
  ), joined AS (
    SELECT m.agent_id, p.full_name, p.phone,
           COALESCE(e.expected,0) AS expected, COALESCE(e.tenants,0) AS tenants,
           COALESCE(g.collected,0) AS collected, COALESCE(g.payments,0) AS payments, g.last_at,
           (m.agent_id = p_parent_agent_id) AS is_leader
    FROM members m
    LEFT JOIN public.profiles p ON p.id = m.agent_id
    LEFT JOIN exp e ON e.agent_id = m.agent_id
    LEFT JOIN got g ON g.agent_id = m.agent_id
  ), tot AS (SELECT SUM(collected) c, SUM(expected) x FROM joined)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'agent_id', j.agent_id,
           'full_name', j.full_name,
           'phone', j.phone,
           'is_leader', j.is_leader,
           'tenants', j.tenants,
           'expected', j.expected,
           'collected', j.collected,
           'payments', j.payments,
           'last_collection_at', j.last_at,
           'rate', CASE WHEN j.expected > 0 THEN ROUND(j.collected*100.0/j.expected,1) END,
           'group_share', CASE WHEN (SELECT c FROM tot) > 0 THEN ROUND(j.collected*100.0/(SELECT c FROM tot),1) END,
           'share_of_group_expected', CASE WHEN (SELECT x FROM tot) > 0 THEN ROUND(j.collected*100.0/(SELECT x FROM tot),1) END
         ) ORDER BY j.collected DESC), '[]'::jsonb)
    INTO v_rows
  FROM joined j;

  SELECT
    (SELECT COUNT(*) FROM (
        SELECT DISTINCT h.member_agent_id FROM public.agent_team_membership_history h
        WHERE h.parent_agent_id = p_parent_agent_id
          AND h.valid_from::date <= p_to AND (h.valid_to IS NULL OR h.valid_to::date >= p_from)
          AND h.member_agent_id <> p_parent_agent_id) s) AS sub_agents,
    COALESCE((SELECT SUM((r->>'collected')::numeric) FROM jsonb_array_elements(v_rows) r),0) AS collected,
    COALESCE((SELECT SUM((r->>'expected')::numeric) FROM jsonb_array_elements(v_rows) r),0) AS expected,
    COALESCE((SELECT SUM((r->>'tenants')::numeric) FROM jsonb_array_elements(v_rows) r),0) AS tenants
  INTO v_sum;

  WITH all_teams AS (
    SELECT h.parent_agent_id, h.member_agent_id
    FROM public.agent_team_membership_history h
    WHERE h.valid_from::date <= p_to AND (h.valid_to IS NULL OR h.valid_to::date >= p_from)
  ), team_agents AS (
    SELECT parent_agent_id, member_agent_id AS agent_id FROM all_teams
    UNION SELECT DISTINCT parent_agent_id, parent_agent_id FROM all_teams
  ), ex AS (SELECT * FROM public.agent_ops_report_expected(p_from, p_to)),
  gt AS (
    SELECT agent_id, SUM(amount) collected FROM public.agent_collections
    WHERE amount > 0 AND (created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
    GROUP BY agent_id
  ), agg AS (
    SELECT ta.parent_agent_id,
           COALESCE(SUM(ex.expected),0) AS expected,
           COALESCE(SUM(gt.collected),0) AS collected
    FROM team_agents ta
    LEFT JOIN ex ON ex.agent_id = ta.agent_id
    LEFT JOIN gt ON gt.agent_id = ta.agent_id
    GROUP BY ta.parent_agent_id
  ), ranked AS (
    SELECT parent_agent_id,
           COUNT(*) FILTER (WHERE TRUE) OVER () AS total_teams,
           RANK() OVER (ORDER BY CASE WHEN expected > 0 THEN collected/expected ELSE -1 END DESC) AS rnk
    FROM agg
  )
  SELECT rnk, total_teams INTO v_rank FROM ranked WHERE parent_agent_id = p_parent_agent_id;

  RETURN jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'leader', COALESCE(v_leader,'{}'::jsonb),
    'kpis', jsonb_build_object(
      'sub_agents', v_sum.sub_agents,
      'collected', v_sum.collected,
      'expected', v_sum.expected,
      'tenants', v_sum.tenants,
      'rate', CASE WHEN v_sum.expected > 0 THEN ROUND(v_sum.collected*100.0/v_sum.expected,1) END,
      'rank', v_rank.rnk,
      'total_teams', v_rank.total_teams
    ),
    'rows', v_rows
  );
END;
$$;
