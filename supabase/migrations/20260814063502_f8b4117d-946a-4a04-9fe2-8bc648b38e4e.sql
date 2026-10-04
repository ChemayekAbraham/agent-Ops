-- 1. Monthly service-centre target config
CREATE TABLE IF NOT EXISTS public.agent_ops_service_centre_targets (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  month date NOT NULL UNIQUE,
  target_count integer NOT NULL DEFAULT 0 CHECK (target_count >= 0),
  note text,
  set_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.agent_ops_service_centre_targets TO authenticated;
GRANT ALL ON public.agent_ops_service_centre_targets TO service_role;

ALTER TABLE public.agent_ops_service_centre_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops roles can view service centre targets"
ON public.agent_ops_service_centre_targets
FOR SELECT TO authenticated
USING (
  public.is_ops_role((select auth.uid()))
  OR public.has_role((select auth.uid()), 'agent_ops')
  OR public.has_role((select auth.uid()), 'manager')
  OR public.has_role((select auth.uid()), 'super_admin')
  OR public.has_role((select auth.uid()), 'coo')
  OR public.has_role((select auth.uid()), 'ceo')
  OR public.has_role((select auth.uid()), 'cfo')
);

CREATE POLICY "Agent ops can insert service centre targets"
ON public.agent_ops_service_centre_targets
FOR INSERT TO authenticated
WITH CHECK (
  public.has_role((select auth.uid()), 'agent_ops')
  OR public.has_role((select auth.uid()), 'manager')
  OR public.has_role((select auth.uid()), 'super_admin')
);

CREATE POLICY "Agent ops can update service centre targets"
ON public.agent_ops_service_centre_targets
FOR UPDATE TO authenticated
USING (
  public.has_role((select auth.uid()), 'agent_ops')
  OR public.has_role((select auth.uid()), 'manager')
  OR public.has_role((select auth.uid()), 'super_admin')
)
WITH CHECK (
  public.has_role((select auth.uid()), 'agent_ops')
  OR public.has_role((select auth.uid()), 'manager')
  OR public.has_role((select auth.uid()), 'super_admin')
);

CREATE TRIGGER update_agent_ops_service_centre_targets_updated_at
BEFORE UPDATE ON public.agent_ops_service_centre_targets
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Authorization helper
CREATE OR REPLACE FUNCTION public.agent_ops_report_authorized()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT current_user IN ('service_role','postgres','supabase_admin')
    OR public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'agent_ops')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'cto');
$$;

-- 3. Daily Agent Products & Services report
CREATE OR REPLACE FUNCTION public.get_agent_products_services_report(p_date date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
SET statement_timeout TO '120s'
AS $$
DECLARE
  v_day date;
  v_start timestamptz;
  v_end timestamptz;
  v_prev_start timestamptz;
  v_month_start date;
  v_month_end date;
  v_target int;
  v_res jsonb;
BEGIN
  IF NOT public.agent_ops_report_authorized() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  v_day := COALESCE(p_date, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_start := (v_day::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end := ((v_day + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_prev_start := ((v_day - 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_month_start := date_trunc('month', v_day)::date;
  v_month_end := (v_month_start + interval '1 month')::date;

  SELECT target_count INTO v_target
  FROM public.agent_ops_service_centre_targets
  WHERE month = v_month_start;

  WITH agents AS (
    SELECT p.id, COALESCE(NULLIF(btrim(p.full_name), ''), p.phone, 'Agent') AS name,
           p.phone, p.created_at, p.location
    FROM profiles p
    JOIN user_roles ur ON ur.user_id = p.id AND ur.role = 'agent'::app_role
  ),
  -- ===== rent =====
  rent_agg AS (
    SELECT
      COALESCE(sum(CASE WHEN ac.created_at >= v_start AND ac.created_at < v_end THEN ac.amount END), 0) AS collected_today,
      COALESCE(sum(CASE WHEN ac.created_at >= v_prev_start AND ac.created_at < v_start THEN ac.amount END), 0) AS collected_prev,
      count(*) FILTER (WHERE ac.created_at >= v_start AND ac.created_at < v_end) AS collections_today
    FROM agent_collections ac
    WHERE ac.created_at >= v_prev_start AND ac.created_at < v_end
  ),
  live_rents AS (
    SELECT rr.agent_id,
           GREATEST(COALESCE(rr.total_repayment,0) - COALESCE(rr.amount_repaid,0), 0) AS outstanding,
           COALESCE(rr.daily_repayment,0) AS daily_repayment,
           COALESCE(rr.amount_repaid,0) AS amount_repaid,
           rr.funded_at
    FROM rent_requests rr
    WHERE rr.status IN ('funded','repaying')
      AND COALESCE(rr.agent_payment_status,'paying') <> 'not_paying'
  ),
  rent_rows AS (
    SELECT a.id AS agent_id, a.name AS agent_name, a.phone, a.location,
           count(lr.agent_id) AS live_plans,
           COALESCE(sum(lr.outstanding),0) AS outstanding,
           COALESCE(sum(lr.daily_repayment),0) AS daily_receivable,
           COALESCE(sum(lr.amount_repaid),0) AS repaid_to_date,
           COALESCE(round(avg(EXTRACT(epoch FROM (v_end - lr.funded_at)) / 86400) FILTER (WHERE lr.outstanding > 0)), 0) AS avg_days_outstanding,
           COALESCE((SELECT sum(ac.amount) FROM agent_collections ac
                      WHERE ac.agent_id = a.id AND ac.created_at >= v_start AND ac.created_at < v_end), 0) AS collected_today
    FROM agents a
    LEFT JOIN live_rents lr ON lr.agent_id = a.id
    GROUP BY a.id, a.name, a.phone, a.location
    HAVING count(lr.agent_id) > 0
       OR COALESCE((SELECT sum(ac.amount) FROM agent_collections ac
                     WHERE ac.agent_id = a.id AND ac.created_at >= v_start AND ac.created_at < v_end), 0) > 0
  ),
  -- ===== advances =====
  adv_req AS (
    SELECT
      count(*) FILTER (WHERE r.created_at >= v_start AND r.created_at < v_end) AS submitted,
      count(*) FILTER (WHERE r.coo_approved_at >= v_start AND r.coo_approved_at < v_end) AS approved,
      count(*) FILTER (WHERE r.status = 'rejected' AND r.updated_at >= v_start AND r.updated_at < v_end) AS rejected
    FROM agent_advance_requests r
  ),
  adv_issued AS (
    SELECT COALESCE(sum(av.principal),0) AS issued_today,
           count(*) AS issued_count
    FROM agent_advances av
    WHERE av.issued_at >= v_start AND av.issued_at < v_end
  ),
  adv_deducted AS (
    SELECT COALESCE(sum(l.amount_deducted),0) AS deducted_today
    FROM agent_advance_ledger l
    WHERE l.date = v_day
  ),
  adv_outstanding AS (
    SELECT COALESCE(sum(av.outstanding_balance),0) AS outstanding,
           count(*) AS active_count
    FROM agent_advances av
    WHERE av.status = 'active'
  ),
  adv_rows AS (
    SELECT av.id, a.name AS agent_name, a.phone, av.status,
           COALESCE(av.principal,0) AS principal,
           COALESCE(av.outstanding_balance,0) AS outstanding,
           GREATEST(COALESCE(av.principal,0) + COALESCE(av.access_fee,0) - COALESCE(av.outstanding_balance,0), 0) AS recovered,
           COALESCE(av.installment_amount, av.daily_installment, 0) AS installment,
           av.issued_at,
           COALESCE((SELECT sum(l.amount_deducted) FROM agent_advance_ledger l
                      WHERE l.advance_id = av.id AND l.date = v_day), 0) AS deducted_today
    FROM agent_advances av
    JOIN agents a ON a.id = av.agent_id
    WHERE av.status = 'active'
       OR (av.issued_at >= v_start AND av.issued_at < v_end)
  ),
  -- ===== service centres =====
  sc AS (
    SELECT
      count(*) FILTER (WHERE s.status IN ('verified','approved')) AS active_total,
      count(*) FILTER (WHERE s.created_at >= v_start AND s.created_at < v_end) AS new_today,
      count(*) FILTER (WHERE s.created_at >= v_prev_start AND s.created_at < v_start) AS new_prev,
      count(*) FILTER (WHERE s.created_at >= (v_month_start::timestamp AT TIME ZONE 'Africa/Kampala')
                         AND s.created_at < (v_month_end::timestamp AT TIME ZONE 'Africa/Kampala')) AS new_this_month,
      count(*) FILTER (WHERE s.status = 'pending') AS pending_total
    FROM service_centre_setups s
  ),
  sc_rows AS (
    SELECT s.id, COALESCE(s.agent_name, a.name, 'Agent') AS agent_name, s.agent_phone,
           s.location_name, s.status, s.created_at, s.verified_at, s.approved_at
    FROM service_centre_setups s
    LEFT JOIN agents a ON a.id = s.agent_id
    ORDER BY s.created_at DESC
    LIMIT 500
  ),
  -- ===== products =====
  prod AS (
    SELECT ms.id,
           CASE WHEN ms.item_name ILIKE '%bike%' THEN 'bike'
                WHEN ms.item_name ILIKE '%phone%' THEN 'smartphone'
                ELSE 'merchandise' END AS product,
           ms.item_name, ms.quantity,
           COALESCE(ms.total_revenue,0) AS value,
           COALESCE(ms.amount_paid,0) AS paid,
           COALESCE(ms.amount_outstanding,0) AS outstanding,
           ms.payment_status, ms.order_status, ms.payment_plan,
           ms.sale_date, ms.client_name, ms.client_phone, ms.customer_id,
           COALESCE(rp.daily_rate, 0) AS daily_rate,
           rp.status AS recovery_status,
           rp.last_recovery_at
    FROM merchandise_sales ms
    LEFT JOIN merchandise_recovery_plans rp ON rp.sale_id = ms.id
  ),
  prod_rows AS (
    SELECT p.*,
           CASE WHEN p.value <= 0 THEN 0 ELSE round((p.paid / p.value) * 100) END AS repayment_rate,
           CASE WHEN p.outstanding <= 0 THEN 'cleared'
                WHEN p.paid > 0 THEN 'on_track'
                ELSE 'behind' END AS repayment_position
    FROM prod p
    WHERE p.product IN ('bike','smartphone')
  ),
  -- ===== agent float =====
  float_day AS (
    SELECT gl.user_id,
           COALESCE(sum(CASE WHEN gl.direction = 'cash_in' THEN gl.amount END),0) AS float_in,
           COALESCE(sum(CASE WHEN gl.direction = 'cash_out' THEN gl.amount END),0) AS float_out,
           count(*) AS txn_count
    FROM general_ledger gl
    WHERE gl.ledger_scope = 'wallet'
      AND gl.wallet_bucket = 'float'
      AND gl.transaction_date >= v_start AND gl.transaction_date < v_end
      AND gl.classification <> 'admin_correction'
    GROUP BY gl.user_id
  ),
  float_rows AS (
    SELECT a.id AS agent_id, a.name AS agent_name, a.phone, a.location,
           COALESCE(fd.float_in,0) AS float_received,
           COALESCE(fd.float_out,0) AS float_paid_out,
           COALESCE(w.float_balance,0) AS closing_float,
           COALESCE(w.withdrawable,0) AS commission_balance,
           COALESCE(fd.txn_count,0) AS transactions,
           COALESCE(ct.collected,0) AS collections_amount,
           COALESCE(ct.n,0) AS collections_count
    FROM agents a
    LEFT JOIN float_day fd ON fd.user_id = a.id
    LEFT JOIN v_user_wallet_strict w ON w.user_id = a.id
    LEFT JOIN (
      SELECT ac.agent_id, sum(ac.amount) AS collected, count(*) AS n
      FROM agent_collections ac
      WHERE ac.created_at >= v_start AND ac.created_at < v_end
      GROUP BY ac.agent_id
    ) ct ON ct.agent_id = a.id
    WHERE COALESCE(fd.txn_count,0) > 0
       OR COALESCE(ct.n,0) > 0
       OR COALESCE(w.float_balance,0) <> 0
  ),
  -- ===== 14-day trend =====
  days AS (
    SELECT (v_day - offs)::date AS d FROM generate_series(0, 13) AS g(offs)
  ),
  trend AS (
    SELECT d.d AS day,
      COALESCE((SELECT sum(ac.amount) FROM agent_collections ac
                 WHERE ac.created_at >= (d.d::timestamp AT TIME ZONE 'Africa/Kampala')
                   AND ac.created_at < ((d.d + 1)::timestamp AT TIME ZONE 'Africa/Kampala')), 0) AS collected,
      COALESCE((SELECT sum(av.principal) FROM agent_advances av
                 WHERE av.issued_at >= (d.d::timestamp AT TIME ZONE 'Africa/Kampala')
                   AND av.issued_at < ((d.d + 1)::timestamp AT TIME ZONE 'Africa/Kampala')), 0) AS advances_issued,
      COALESCE((SELECT sum(l.amount_deducted) FROM agent_advance_ledger l WHERE l.date = d.d), 0) AS advances_deducted,
      COALESCE((SELECT count(*) FROM service_centre_setups s
                 WHERE s.created_at >= (d.d::timestamp AT TIME ZONE 'Africa/Kampala')
                   AND s.created_at < ((d.d + 1)::timestamp AT TIME ZONE 'Africa/Kampala')), 0) AS service_centres_added,
      COALESCE((SELECT count(*) FROM profiles p
                 JOIN user_roles ur ON ur.user_id = p.id AND ur.role = 'agent'::app_role
                 WHERE p.created_at >= (d.d::timestamp AT TIME ZONE 'Africa/Kampala')
                   AND p.created_at < ((d.d + 1)::timestamp AT TIME ZONE 'Africa/Kampala')), 0) AS new_agents
    FROM days d
  )
  SELECT jsonb_build_object(
    'day', v_day,
    'timezone', 'Africa/Kampala',
    'generated_at', now(),
    'agents', jsonb_build_object(
      'new_today', (SELECT count(*) FROM agents WHERE created_at >= v_start AND created_at < v_end),
      'new_prev', (SELECT count(*) FROM agents WHERE created_at >= v_prev_start AND created_at < v_start),
      'total', (SELECT count(*) FROM agents WHERE created_at < v_end),
      'base', (SELECT count(*) FROM agents WHERE created_at < v_start),
      'active_today', (SELECT count(DISTINCT ac.agent_id) FROM agent_collections ac
                        WHERE ac.created_at >= v_start AND ac.created_at < v_end)
    ),
    'rent', jsonb_build_object(
      'collected_today', (SELECT collected_today FROM rent_agg),
      'collected_prev', (SELECT collected_prev FROM rent_agg),
      'collections_today', (SELECT collections_today FROM rent_agg),
      'outstanding', (SELECT COALESCE(sum(outstanding),0) FROM live_rents),
      'daily_receivable', (SELECT COALESCE(sum(daily_repayment),0) FROM live_rents),
      'live_plans', (SELECT count(*) FROM live_rents),
      'avg_days_outstanding', (SELECT COALESCE(round(avg(EXTRACT(epoch FROM (v_end - funded_at)) / 86400)), 0)
                                 FROM live_rents WHERE outstanding > 0 AND funded_at IS NOT NULL)
    ),
    'advances', jsonb_build_object(
      'submitted', (SELECT submitted FROM adv_req),
      'approved', (SELECT approved FROM adv_req),
      'rejected', (SELECT rejected FROM adv_req),
      'issued_today', (SELECT issued_today FROM adv_issued),
      'issued_count', (SELECT issued_count FROM adv_issued),
      'deducted_today', (SELECT deducted_today FROM adv_deducted),
      'outstanding', (SELECT outstanding FROM adv_outstanding),
      'active_count', (SELECT active_count FROM adv_outstanding)
    ),
    'service_centres', jsonb_build_object(
      'active_total', (SELECT active_total FROM sc),
      'new_today', (SELECT new_today FROM sc),
      'new_prev', (SELECT new_prev FROM sc),
      'new_this_month', (SELECT new_this_month FROM sc),
      'pending_total', (SELECT pending_total FROM sc),
      'monthly_target', COALESCE(v_target, 0),
      'target_month', v_month_start
    ),
    'bikes', (SELECT jsonb_build_object(
        'issued_today', count(*) FILTER (WHERE sale_date = v_day),
        'issued_total', count(*),
        'total_value', COALESCE(sum(value),0),
        'paid', COALESCE(sum(paid),0),
        'outstanding', COALESCE(sum(outstanding),0),
        'daily_receivable', COALESCE(sum(daily_rate) FILTER (WHERE outstanding > 0),0)
      ) FROM prod_rows WHERE product = 'bike'),
    'phones', (SELECT jsonb_build_object(
        'issued_today', count(*) FILTER (WHERE sale_date = v_day),
        'issued_total', count(*),
        'total_value', COALESCE(sum(value),0),
        'paid', COALESCE(sum(paid),0),
        'outstanding', COALESCE(sum(outstanding),0),
        'daily_receivable', COALESCE(sum(daily_rate) FILTER (WHERE outstanding > 0),0)
      ) FROM prod_rows WHERE product = 'smartphone'),
    'trend', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.day), '[]'::jsonb) FROM trend t),
    'rent_rows', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.outstanding DESC), '[]'::jsonb) FROM rent_rows r),
    'advance_rows', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.outstanding DESC), '[]'::jsonb) FROM adv_rows x),
    'service_centre_rows', (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]'::jsonb) FROM sc_rows s),
    'product_rows', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.outstanding DESC), '[]'::jsonb) FROM prod_rows p),
    'agent_float_rows', (SELECT COALESCE(jsonb_agg(to_jsonb(f) ORDER BY f.collections_amount DESC), '[]'::jsonb) FROM float_rows f)
  ) INTO v_res;

  RETURN v_res;
END;
$$;

REVOKE ALL ON FUNCTION public.get_agent_products_services_report(date) FROM public;
GRANT EXECUTE ON FUNCTION public.get_agent_products_services_report(date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agent_ops_report_authorized() TO authenticated, service_role;