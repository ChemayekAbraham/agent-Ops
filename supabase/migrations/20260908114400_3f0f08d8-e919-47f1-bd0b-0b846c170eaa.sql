
-- ============ helpers-free, single-round-trip report aggregators ============

CREATE OR REPLACE FUNCTION public.agent_ops_report_agent_search(p_search text DEFAULT NULL, p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('agent_id', a.agent_id, 'full_name', a.full_name, 'phone', a.phone, 'tenants', a.tenants) ORDER BY a.full_name), '[]'::jsonb)
  FROM (
    SELECT rr.agent_id,
           MAX(p.full_name) AS full_name,
           MAX(p.phone)     AS phone,
           COUNT(DISTINCT rr.id) AS tenants
    FROM public.rent_requests rr
    JOIN public.profiles p ON p.id = rr.agent_id
    WHERE public.agent_ops_report_authorized()
      AND rr.agent_id IS NOT NULL
      AND (p_search IS NULL OR p_search = ''
           OR p.full_name ILIKE '%'||p_search||'%' OR p.phone ILIKE '%'||p_search||'%')
    GROUP BY rr.agent_id
    ORDER BY MAX(p.full_name)
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit,25), 100))
  ) a;
$$;

CREATE OR REPLACE FUNCTION public.agent_ops_report_team_search(p_search text DEFAULT NULL, p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('parent_agent_id', t.parent_agent_id, 'full_name', t.full_name, 'phone', t.phone, 'members', t.members) ORDER BY t.full_name), '[]'::jsonb)
  FROM (
    SELECT h.parent_agent_id,
           MAX(p.full_name) AS full_name,
           MAX(p.phone) AS phone,
           COUNT(DISTINCT h.member_agent_id) AS members
    FROM public.agent_team_membership_history h
    JOIN public.profiles p ON p.id = h.parent_agent_id
    WHERE public.agent_ops_report_authorized()
      AND (p_search IS NULL OR p_search = ''
           OR p.full_name ILIKE '%'||p_search||'%' OR p.phone ILIKE '%'||p_search||'%')
    GROUP BY h.parent_agent_id
    ORDER BY MAX(p.full_name)
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit,25), 100))
  ) t;
$$;

-- ---------------- Agent report ----------------
CREATE OR REPLACE FUNCTION public.agent_ops_report_agent(p_agent_id uuid, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_agent jsonb;
  v_tenants jsonb;
  v_periods jsonb;
  v_k record;
BEGIN
  IF NOT public.agent_ops_report_authorized() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF p_agent_id IS NULL OR p_from IS NULL OR p_to IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;

  SELECT jsonb_build_object('agent_id', p.id, 'full_name', p.full_name, 'phone', p.phone,
                            'territory', p.territory)
    INTO v_agent
  FROM public.profiles p WHERE p.id = p_agent_id;

  WITH plans AS (
    SELECT rr.id, rr.tenant_id, rr.rent_amount, rr.total_repayment, rr.daily_repayment,
           COALESCE(rr.amount_repaid,0) AS amount_repaid, rr.status, rr.repayment_frequency
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
    SELECT e.day, SUM(e.expected_ugx) AS expected
    FROM public.agent_expected_day_plans e
    WHERE e.agent_id = p_agent_id AND e.day BETWEEN p_from AND p_to
    GROUP BY e.day
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

  SELECT
    (SELECT COUNT(*) FROM public.rent_requests rr WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id) AND rr.status IN ('funded','repaying','completed')) AS assigned_tenants,
    (SELECT COUNT(*) FROM public.rent_requests rr WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id) AND rr.status IN ('funded','repaying')) AS active_repaying,
    (SELECT COALESCE(SUM(rr.rent_amount),0) FROM public.rent_requests rr WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id) AND rr.status IN ('funded','repaying','completed')) AS rent_total,
    (SELECT COALESCE(SUM(rr.total_repayment),0) FROM public.rent_requests rr WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id) AND rr.status IN ('funded','repaying','completed')) AS repayment_total,
    (SELECT COALESCE(SUM(rr.amount_repaid),0) FROM public.rent_requests rr WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id) AND rr.status IN ('funded','repaying','completed')) AS repaid_total,
    (SELECT COALESCE(SUM(e.expected_ugx),0) FROM public.agent_expected_day_plans e WHERE e.agent_id = p_agent_id AND e.day BETWEEN p_from AND p_to) AS expected_window,
    (SELECT COALESCE(SUM(ac.amount),0) FROM public.agent_collections ac WHERE ac.agent_id = p_agent_id AND ac.amount > 0 AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to) AS collected_window
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
      'expected_window', v_k.expected_window,
      'collected_window', v_k.collected_window,
      'repayment_rate', CASE WHEN v_k.repayment_total > 0 THEN ROUND(v_k.repaid_total*100.0/v_k.repayment_total,1) END,
      'window_rate', CASE WHEN v_k.expected_window > 0 THEN ROUND(v_k.collected_window*100.0/v_k.expected_window,1) END
    ),
    'tenants', v_tenants,
    'periods', v_periods
  );
END;
$$;

-- ---------------- Rent collections report ----------------
CREATE OR REPLACE FUNCTION public.agent_ops_report_rent_collections(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_rows jsonb; v_sum record;
BEGIN
  IF NOT public.agent_ops_report_authorized() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF p_from IS NULL OR p_to IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;

  CREATE TEMP TABLE IF NOT EXISTS _noop_rc (x int) ON COMMIT DROP;

  WITH exp AS (
    SELECT e.agent_id,
           SUM(e.expected_ugx) AS expected,
           COUNT(DISTINCT e.rent_request_id) AS repaying_tenants
    FROM public.agent_expected_day_plans e
    WHERE e.day BETWEEN p_from AND p_to
    GROUP BY e.agent_id
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
           COALESCE(e.repaying_tenants,0) AS repaying_tenants,
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
    (SELECT COUNT(DISTINCT e.agent_id) FROM public.agent_expected_day_plans e WHERE e.day BETWEEN p_from AND p_to) AS total_agents,
    (SELECT COUNT(DISTINCT ac.agent_id) FROM public.agent_collections ac WHERE ac.amount > 0 AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to) AS active_agents,
    (SELECT COALESCE(SUM(e.expected_ugx),0) FROM public.agent_expected_day_plans e WHERE e.day BETWEEN p_from AND p_to) AS expected,
    (SELECT COALESCE(SUM(ac.amount),0) FROM public.agent_collections ac WHERE ac.amount > 0 AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to) AS collected,
    (SELECT COUNT(DISTINCT e.rent_request_id) FROM public.agent_expected_day_plans e WHERE e.day BETWEEN p_from AND p_to) AS repaying_tenants
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

-- ---------------- Products & services report ----------------
CREATE OR REPLACE FUNCTION public.agent_ops_report_products(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_rows jsonb; v_sum record;
BEGIN
  IF NOT public.agent_ops_report_authorized() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF p_from IS NULL OR p_to IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;

  WITH sales AS (
    SELECT s.id, s.customer_id, s.client_name, s.client_phone, s.item_name,
           COALESCE(s.quantity,1) AS quantity,
           COALESCE(s.total_revenue,0) AS value,
           COALESCE(s.amount_paid,0) AS paid,
           COALESCE(s.amount_outstanding,0) AS outstanding,
           COALESCE(s.order_status,'issued') AS order_status,
           COALESCE(s.sale_date, s.created_at::date) AS sale_date,
           s.payment_plan
    FROM public.merchandise_sales s
    WHERE COALESCE(s.sale_date, s.created_at::date) BETWEEN p_from AND p_to
  ), plan_agg AS (
    SELECT r.sale_id, SUM(COALESCE(r.amount_recovered,0)) AS recovered
    FROM public.merchandise_recovery_plans r
    WHERE r.sale_id IN (SELECT id FROM sales)
    GROUP BY r.sale_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'sale_id', x.id,
           'agent_id', x.customer_id,
           'full_name', x.full_name,
           'phone', x.phone,
           'product', x.item_name,
           'category', public.agent_product_category(x.item_name),
           'quantity', x.quantity,
           'status', x.order_status,
           'value', x.value,
           'recovered', x.recovered,
           'outstanding', x.outstanding,
           'payment_plan', x.payment_plan,
           'date', x.sale_date
         ) ORDER BY x.sale_date DESC), '[]'::jsonb)
    INTO v_rows
  FROM (
    SELECT s.*, COALESCE(p.full_name, s.client_name) AS full_name,
           COALESCE(p.phone, s.client_phone) AS phone,
           GREATEST(COALESCE(pa.recovered, s.paid), 0) AS recovered
    FROM sales s
    LEFT JOIN public.profiles p ON p.id = s.customer_id
    LEFT JOIN plan_agg pa ON pa.sale_id = s.id
  ) x;

  SELECT
    COUNT(*) AS applications,
    COUNT(*) FILTER (WHERE lower(COALESCE(s.order_status,'issued')) IN ('approved','issued','completed')) AS approved,
    COUNT(*) FILTER (WHERE lower(COALESCE(s.order_status,'issued')) IN ('pending_approval','submitted','processing')) AS pending,
    COALESCE(SUM(COALESCE(s.total_revenue,0)),0) AS value_issued,
    COALESCE(SUM(COALESCE(s.amount_paid,0)),0) AS recovered,
    COALESCE(SUM(COALESCE(s.amount_outstanding,0)),0) AS outstanding
  INTO v_sum
  FROM public.merchandise_sales s
  WHERE COALESCE(s.sale_date, s.created_at::date) BETWEEN p_from AND p_to;

  RETURN jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'kpis', jsonb_build_object(
      'applications', v_sum.applications,
      'approved', v_sum.approved,
      'pending', v_sum.pending,
      'value_issued', v_sum.value_issued,
      'recovered', v_sum.recovered,
      'outstanding', v_sum.outstanding,
      'recovery_rate', CASE WHEN v_sum.value_issued > 0 THEN ROUND(v_sum.recovered*100.0/v_sum.value_issued,1) END
    ),
    'rows', v_rows
  );
END;
$$;

-- ---------------- Advances report ----------------
CREATE OR REPLACE FUNCTION public.agent_ops_report_advances(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_rows jsonb; v_stages jsonb; v_sum record;
BEGIN
  IF NOT public.agent_ops_report_authorized() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF p_from IS NULL OR p_to IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;

  WITH adv AS (
    SELECT a.id, a.agent_id, a.principal, COALESCE(a.access_fee,0) AS access_fee,
           COALESCE(a.registration_fee,0) AS registration_fee,
           COALESCE(a.outstanding_balance,0) AS outstanding,
           COALESCE(a.arrears_balance,0) AS arrears,
           a.status, a.issued_at, a.expires_at, a.repayment_frequency,
           COALESCE(a.installment_amount, a.daily_installment, 0) AS installment
    FROM public.agent_advances a
    WHERE (a.issued_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
  ), repaid AS (
    SELECT l.advance_id, SUM(COALESCE(l.amount_deducted,0)) AS repaid
    FROM public.agent_advance_ledger l
    WHERE l.advance_id IN (SELECT id FROM adv)
    GROUP BY l.advance_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'advance_id', x.id,
           'agent_id', x.agent_id,
           'full_name', x.full_name,
           'phone', x.phone,
           'disbursed', x.principal,
           'access_fee', x.access_fee,
           'repaid', x.repaid,
           'outstanding', x.outstanding,
           'overdue', x.arrears,
           'installment', x.installment,
           'frequency', x.repayment_frequency,
           'recovery_rate', x.recovery_rate,
           'status', x.status,
           'issued_at', x.issued_at,
           'expires_at', x.expires_at
         ) ORDER BY x.issued_at DESC), '[]'::jsonb)
    INTO v_rows
  FROM (
    SELECT a.*, p.full_name, p.phone, COALESCE(r.repaid,0) AS repaid,
           CASE WHEN (a.principal + a.access_fee) > 0
                THEN ROUND(COALESCE(r.repaid,0)*100.0/(a.principal + a.access_fee),1) END AS recovery_rate
    FROM adv a
    LEFT JOIN public.profiles p ON p.id = a.agent_id
    LEFT JOIN repaid r ON r.advance_id = a.id
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'stage', s.status, 'count', s.n, 'value', s.value) ORDER BY s.value DESC), '[]'::jsonb)
    INTO v_stages
  FROM (
    SELECT COALESCE(a.status,'unknown') AS status, COUNT(*) AS n, COALESCE(SUM(a.principal),0) AS value
    FROM public.agent_advances a
    WHERE (a.issued_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
    GROUP BY 1
  ) s;

  SELECT
    (SELECT COUNT(*) FROM public.agent_advances a WHERE (a.issued_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to) AS issued_count,
    (SELECT COALESCE(SUM(a.principal),0) FROM public.agent_advances a WHERE (a.issued_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to) AS volume,
    (SELECT COUNT(DISTINCT a.agent_id) FROM public.agent_advances a WHERE (a.issued_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to) AS agents,
    (SELECT COALESCE(SUM(l.amount_deducted),0) FROM public.agent_advance_ledger l
       WHERE l.date BETWEEN p_from AND p_to) AS repaid,
    (SELECT COALESCE(SUM(a.outstanding_balance),0) FROM public.agent_advances a WHERE a.status IN ('active','repaying','overdue')) AS outstanding_now,
    (SELECT COALESCE(SUM(a.arrears_balance),0) FROM public.agent_advances a WHERE a.status IN ('active','repaying','overdue')) AS arrears_now,
    (SELECT COUNT(*) FROM public.agent_advance_requests r WHERE r.created_at::date BETWEEN p_from AND p_to AND r.status NOT IN ('paid','rejected','cancelled')) AS pending_apps
  INTO v_sum;

  RETURN jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'kpis', jsonb_build_object(
      'issued_count', v_sum.issued_count,
      'volume', v_sum.volume,
      'agents', v_sum.agents,
      'repaid', v_sum.repaid,
      'outstanding', v_sum.outstanding_now,
      'arrears', v_sum.arrears_now,
      'pending_apps', v_sum.pending_apps,
      'recovery_rate', CASE WHEN v_sum.volume > 0 THEN ROUND(v_sum.repaid*100.0/v_sum.volume,1) END
    ),
    'stages', v_stages,
    'rows', v_rows
  );
END;
$$;

-- ---------------- Team collections report ----------------
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
    SELECT e.agent_id, SUM(e.expected_ugx) AS expected, COUNT(DISTINCT e.rent_request_id) AS tenants
    FROM public.agent_expected_day_plans e
    WHERE e.day BETWEEN p_from AND p_to AND e.agent_id IN (SELECT agent_id FROM members)
    GROUP BY e.agent_id
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
           'group_share', CASE WHEN (SELECT x FROM tot) > 0 THEN ROUND(j.collected*100.0/(SELECT x FROM tot),1) END
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
  ), agg AS (
    SELECT ta.parent_agent_id,
           COALESCE(SUM(e.expected),0) AS expected,
           COALESCE(SUM(g.collected),0) AS collected
    FROM team_agents ta
    LEFT JOIN (SELECT agent_id, SUM(expected_ugx) expected FROM public.agent_expected_day_plans
               WHERE day BETWEEN p_from AND p_to GROUP BY agent_id) e ON e.agent_id = ta.agent_id
    LEFT JOIN (SELECT agent_id, SUM(amount) collected FROM public.agent_collections
               WHERE amount > 0 AND (created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
               GROUP BY agent_id) g ON g.agent_id = ta.agent_id
    GROUP BY ta.parent_agent_id
  ), ranked AS (
    SELECT parent_agent_id,
           CASE WHEN expected > 0 THEN collected/expected ELSE NULL END AS ratio,
           COUNT(*) OVER () AS total_teams,
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

GRANT EXECUTE ON FUNCTION public.agent_ops_report_agent_search(text,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_ops_report_team_search(text,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_ops_report_agent(uuid,date,date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_ops_report_rent_collections(date,date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_ops_report_products(date,date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_ops_report_advances(date,date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_ops_report_team_collections(uuid,date,date) TO authenticated;
