CREATE OR REPLACE FUNCTION public.get_agent_products_services_report(p_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
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

  WITH agent_qual AS (
    SELECT s.uid, MIN(s.ts) AS first_ts
    FROM (
      SELECT rr.agent_id AS uid, MIN(rr.created_at) AS ts
        FROM rent_requests rr
        WHERE rr.agent_id IS NOT NULL AND rr.tenant_id IS NOT NULL AND rr.agent_id <> rr.tenant_id
        GROUP BY rr.agent_id
      UNION ALL
      SELECT ac.agent_id, MIN(ac.created_at)
        FROM agent_collections ac
        WHERE ac.agent_id IS NOT NULL
        GROUP BY ac.agent_id
      UNION ALL
      SELECT lr.uid, lr.created_at
        FROM (
          SELECT hl.agent_id AS uid, hl.created_at,
                 row_number() OVER (PARTITION BY hl.agent_id ORDER BY hl.created_at) AS rn
            FROM house_listings hl
           WHERE hl.agent_id IS NOT NULL
        ) lr
       WHERE lr.rn = 3
    ) s
    WHERE s.uid IS NOT NULL
    GROUP BY s.uid
  ),
  sub_agents AS (
    SELECT sub_agent_id AS uid, MIN(created_at) AS first_ts
    FROM public.agent_subagents
    WHERE status IN ('verified', 'pending_acceptance')
    GROUP BY sub_agent_id
  ),
  all_agents AS (
    SELECT uid, MIN(first_ts) AS created_at
    FROM (
      SELECT uid, first_ts FROM agent_qual
      UNION ALL
      SELECT uid, first_ts FROM sub_agents
    ) s
    GROUP BY uid
  ),
  agents AS (
    SELECT a.uid AS id,
           COALESCE(NULLIF(btrim(p.full_name), ''), p.phone, 'Agent') AS name,
           p.phone,
           a.created_at,
           COALESCE(NULLIF(btrim(p.district), ''), NULLIF(btrim(p.city), ''), '—') AS location
    FROM all_agents a
    LEFT JOIN profiles p ON p.id = a.uid
  ),
  active_day AS (
    SELECT DISTINCT uid FROM (
      SELECT rr.agent_id AS uid FROM rent_requests rr
        WHERE rr.agent_id IS NOT NULL AND rr.created_at >= v_start AND rr.created_at < v_end
      UNION
      SELECT ac.agent_id FROM agent_collections ac
        WHERE ac.agent_id IS NOT NULL AND ac.created_at >= v_start AND ac.created_at < v_end
      UNION
      SELECT av.agent_id FROM agent_visits av
        WHERE av.agent_id IS NOT NULL AND av.created_at >= v_start AND av.created_at < v_end
    ) x
  ),
  new_agent_rows AS (
    SELECT
      a.id,
      a.name,
      a.phone,
      a.location,
      a.created_at,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM public.agent_subagents sa
          WHERE sa.sub_agent_id = a.id
            AND sa.status IN ('verified', 'pending_acceptance')
        ) THEN 'sub-agent'
        ELSE 'main agent'
      END AS agent_type,
      COALESCE(NULLIF(btrim(parent.full_name), ''), parent.phone, '—') AS parent_name
    FROM agents a
    LEFT JOIN public.agent_subagents sa
      ON sa.sub_agent_id = a.id
     AND sa.status IN ('verified', 'pending_acceptance')
    LEFT JOIN profiles parent ON parent.id = sa.parent_agent_id
    WHERE a.created_at >= v_start AND a.created_at < v_end
  ),
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
    WHERE rr.status IN ('funded','repaying','disbursed','active')
      AND COALESCE(rr.tenancy_status,'active') <> 'ended'
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
  adv_req AS (
    SELECT
      count(*) FILTER (WHERE r.created_at >= v_start AND r.created_at < v_end) AS submitted,
      count(*) FILTER (WHERE r.coo_approved_at >= v_start AND r.coo_approved_at < v_end) AS approved,
      count(*) FILTER (WHERE r.status = 'rejected' AND r.updated_at >= v_start AND r.updated_at < v_end) AS rejected
    FROM agent_advance_requests r
  ),
  adv_issued AS (
    SELECT COALESCE(sum(av.principal),0) AS issued_today, count(*) AS issued_count
    FROM agent_advances av
    WHERE av.issued_at >= v_start AND av.issued_at < v_end
  ),
  adv_deducted AS (
    SELECT COALESCE(sum(l.amount_deducted),0) AS deducted_today
    FROM agent_advance_ledger l WHERE l.date = v_day
  ),
  adv_outstanding AS (
    SELECT COALESCE(sum(av.outstanding_balance),0) AS outstanding,
           count(*) AS active_count,
           count(*) FILTER (WHERE COALESCE(av.arrears_balance,0) > 0) AS behind_count,
           COALESCE(sum(av.arrears_balance),0) AS arrears_total
    FROM agent_advances av WHERE av.status IN ('active','disbursed','overdue')
  ),
  adv_rows AS (
    SELECT av.id,
           COALESCE(NULLIF(btrim(p.full_name), ''), p.phone, 'Agent') AS agent_name,
           p.phone, av.status,
           COALESCE(av.principal,0) AS principal,
           COALESCE(av.outstanding_balance,0) AS outstanding,
           GREATEST(COALESCE(av.principal,0) + COALESCE(av.access_fee,0) - COALESCE(av.outstanding_balance,0), 0) AS recovered,
           COALESCE(av.installment_amount, av.daily_installment, 0) AS installment,
           av.issued_at,
           COALESCE((SELECT sum(l.amount_deducted) FROM agent_advance_ledger l
                      WHERE l.advance_id = av.id AND l.date = v_day), 0) AS deducted_today
    FROM agent_advances av
    LEFT JOIN profiles p ON p.id = av.agent_id
    WHERE av.status IN ('active','disbursed','overdue') OR (av.issued_at >= v_start AND av.issued_at < v_end)
  ),
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
    SELECT s.id,
           COALESCE(s.agent_name, NULLIF(btrim(p.full_name), ''), 'Agent') AS agent_name,
           s.agent_phone, s.location_name, s.status, s.created_at, s.verified_at, s.approved_at
    FROM service_centre_setups s
    LEFT JOIN profiles p ON p.id = s.agent_id
    ORDER BY s.created_at DESC
    LIMIT 500
  ),
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
  float_day AS (
    SELECT gl.user_id,
           COALESCE(sum(CASE WHEN gl.direction = 'cash_in' THEN gl.amount END),0) AS float_in,
           COALESCE(sum(CASE WHEN gl.direction = 'cash_out' THEN gl.amount END),0) AS float_out,
           count(*) AS txn_count
    FROM general_ledger gl
    WHERE gl.ledger_scope = 'wallet'
      AND gl.wallet_bucket = 'float'
      AND gl.transaction_date >= v_start AND gl.transaction_date < v_end
      AND COALESCE(gl.classification,'') <> 'admin_correction'
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
  days AS (SELECT (v_day - offs)::date AS d FROM generate_series(0, 13) AS g(offs)),
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
      COALESCE((SELECT count(*) FROM agents a
                 WHERE a.created_at >= (d.d::timestamp AT TIME ZONE 'Africa/Kampala')
                   AND a.created_at < ((d.d + 1)::timestamp AT TIME ZONE 'Africa/Kampala')), 0) AS new_agents
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
      'active_today', (SELECT count(*) FROM active_day d
                        WHERE d.uid IN (SELECT id FROM agents WHERE created_at < v_end))
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
      'active_count', (SELECT active_count FROM adv_outstanding),
      'behind_count', (SELECT behind_count FROM adv_outstanding),
      'arrears_total', (SELECT arrears_total FROM adv_outstanding)
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
    'new_agent_rows', (SELECT COALESCE(jsonb_agg(to_jsonb(n) ORDER BY n.created_at), '[]'::jsonb) FROM new_agent_rows n),
    'rent_rows', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.outstanding DESC), '[]'::jsonb) FROM rent_rows r),
    'advance_rows', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.outstanding DESC), '[]'::jsonb) FROM adv_rows x),
    'service_centre_rows', (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]'::jsonb) FROM sc_rows s),
    'product_rows', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.outstanding DESC), '[]'::jsonb) FROM prod_rows p),
    'agent_float_rows', (SELECT COALESCE(jsonb_agg(to_jsonb(f) ORDER BY f.collections_amount DESC), '[]'::jsonb) FROM float_rows f)
  ) INTO v_res;

  RETURN v_res;
END;
$function$;
