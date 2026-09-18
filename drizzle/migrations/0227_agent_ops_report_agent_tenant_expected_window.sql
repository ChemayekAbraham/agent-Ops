CREATE OR REPLACE FUNCTION public.agent_ops_report_agent(p_agent_id uuid, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_agent jsonb;
  v_tenants jsonb;
  v_periods jsonb;
  v_k record;
  v_expected numeric;
  v_today date;
  v_asof date;
BEGIN
  IF NOT public.agent_ops_report_authorized() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF p_agent_id IS NULL OR p_from IS NULL OR p_to IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;

  v_today := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_asof := LEAST(p_to, v_today);

  SELECT jsonb_build_object('agent_id', p.id, 'full_name', p.full_name, 'phone', p.phone,
                            'territory', p.territory)
    INTO v_agent
  FROM public.profiles p WHERE p.id = p_agent_id;

  WITH plans AS (
    SELECT rr.id, rr.tenant_id, rr.rent_amount, rr.total_repayment, rr.daily_repayment,
           COALESCE(rr.amount_repaid,0) AS amount_repaid, rr.status, rr.house_category
    FROM public.rent_requests rr
    WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id)
      AND rr.status IN ('funded','repaying','completed')
  ), bill AS (
    SELECT p.rent_request_id, sum(p.expected_ugx)::numeric AS expected_window
    FROM public.agent_expected_day_plans p
    WHERE p.agent_id = p_agent_id
      AND p.day BETWEEN p_from AND v_asof
    GROUP BY p.rent_request_id
  ), coll_raw AS (
    SELECT ac.rent_request_id, sum(ac.amount)::numeric AS paid,
           count(*)::int AS payments, max(ac.created_at) AS last_at
    FROM public.agent_collections ac
    WHERE ac.reversed_at IS NULL AND ac.amount > 0
      AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
      AND ac.rent_request_id IN (SELECT id FROM plans)
    GROUP BY ac.rent_request_id
  ), coll AS (
    SELECT COALESCE(b.rent_request_id, cr.rent_request_id) AS rent_request_id,
           CASE WHEN b.expected_window IS NOT NULL THEN LEAST(COALESCE(cr.paid, 0), b.expected_window) ELSE 0 END AS collected_window,
           COALESCE(cr.payments, 0)::int AS payments,
           cr.last_at
    FROM bill b
    FULL OUTER JOIN coll_raw cr ON cr.rent_request_id = b.rent_request_id
  ), rows_ranked AS (
    SELECT ac.rent_request_id, ac.created_at, ac.amount, ac.expected_amount,
           ac.shortfall_amount, ac.is_partial, ac.collection_channel,
           ac.payment_method, ac.momo_provider, ac.tracking_id, ac.momo_transaction_id,
           row_number() OVER (PARTITION BY ac.rent_request_id ORDER BY ac.created_at DESC) AS rn,
           count(*)     OVER (PARTITION BY ac.rent_request_id) AS total_rn
    FROM public.agent_collections ac
    WHERE ac.reversed_at IS NULL AND ac.amount > 0
      AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
      AND ac.rent_request_id IN (SELECT id FROM plans)
  ), hist AS (
    SELECT r.rent_request_id, bool_or(r.total_rn > 100) AS truncated,
           jsonb_agg(jsonb_build_object(
             'at', r.created_at,
             'ref', COALESCE(NULLIF(TRIM(r.tracking_id),''), NULLIF(TRIM(r.momo_transaction_id),'')),
             'expected', r.expected_amount,
             'collected', r.amount,
             'shortfall', COALESCE(r.shortfall_amount, 0),
             'channel', COALESCE(NULLIF(TRIM(r.collection_channel),''), NULLIF(TRIM(r.momo_provider),''), NULLIF(TRIM(r.payment_method::text),'')),
             'status', CASE WHEN COALESCE(r.is_partial,false) OR COALESCE(r.shortfall_amount,0) > 0 THEN 'Partial' ELSE 'Settled' END
           ) ORDER BY r.created_at DESC) AS history
    FROM rows_ranked r WHERE r.rn <= 100 GROUP BY r.rent_request_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'rent_request_id', x.id, 'tenant_name', x.tenant_name, 'tenant_phone', x.tenant_phone,
           'rent_amount', x.rent_amount, 'outstanding', x.outstanding, 'repayment', x.total_repayment,
           'expected_window', x.expected_window,
           'collected', x.collected_window, 'collected_to_date', x.amount_repaid,
           'payments', x.payments, 'percentage', x.percentage,
           'last_collection_at', x.last_at, 'status', x.status,
           'national_id', x.national_id, 'occupation', x.occupation,
           'location', x.location, 'house_type', x.house_type,
           'daily_repayment', x.daily_repayment,
           'history', COALESCE(x.history, '[]'::jsonb),
           'history_truncated', COALESCE(x.truncated, false)
         ) ORDER BY x.collected_window DESC NULLS LAST, x.tenant_name), '[]'::jsonb)
    INTO v_tenants
  FROM (
    SELECT pl.id, pl.rent_amount, pl.total_repayment, pl.amount_repaid, pl.status, pl.daily_repayment,
           tp.full_name AS tenant_name, tp.phone AS tenant_phone, tp.national_id, tp.occupation,
           COALESCE(
             NULLIF(CONCAT_WS(', ',
               NULLIF(TRIM(COALESCE(tp.village, tp.city)),''),
               NULLIF(TRIM(tp.sub_county),''),
               NULLIF(TRIM(tp.district),'')
             ), ''),
             NULLIF(TRIM(tp.region),'')
           ) AS location,
           NULLIF(TRIM(pl.house_category),'') AS house_type,
           GREATEST(COALESCE(pl.total_repayment,0) - pl.amount_repaid, 0) AS outstanding,
           COALESCE(b.expected_window,0) AS expected_window,
           COALESCE(c.collected_window,0) AS collected_window,
           COALESCE(c.payments,0) AS payments, c.last_at, h.history, h.truncated,
           CASE WHEN COALESCE(pl.total_repayment,0) > 0
                THEN ROUND(pl.amount_repaid * 100.0 / pl.total_repayment, 1) ELSE NULL END AS percentage
    FROM plans pl
    LEFT JOIN bill b ON b.rent_request_id = pl.id
    LEFT JOIN coll c ON c.rent_request_id = pl.id
    LEFT JOIN hist h ON h.rent_request_id = pl.id
    WHERE pl.status IN ('funded','repaying') OR c.rent_request_id IS NOT NULL OR b.rent_request_id IS NOT NULL
  ) x;

  WITH days AS (SELECT d::date AS day FROM generate_series(p_from, p_to, interval '1 day') d),
  exp AS (
    SELECT p.day, SUM(p.expected_ugx)::numeric AS expected
    FROM public.agent_expected_day_plans p
    WHERE p.agent_id = p_agent_id AND p.day BETWEEN p_from AND v_asof GROUP BY p.day
  ), got AS (
    SELECT b.day,
           SUM(LEAST(COALESCE(c.paid, 0), b.expected_ugx))::numeric AS collected,
           SUM(COALESCE(c.payments, 0))::int AS payments
    FROM public.agent_expected_day_plans b
    LEFT JOIN LATERAL (
      SELECT SUM(ac.amount)::numeric AS paid, COUNT(*)::int AS payments
      FROM public.agent_collections ac
      WHERE ac.reversed_at IS NULL AND ac.amount > 0
        AND ac.rent_request_id = b.rent_request_id
        AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date = b.day
    ) c ON true
    WHERE b.agent_id = p_agent_id AND b.day BETWEEN p_from AND v_asof
    GROUP BY b.day
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
  FROM days d LEFT JOIN exp e ON e.day = d.day LEFT JOIN got g ON g.day = d.day;

  SELECT COALESCE(SUM(e.expected),0) INTO v_expected
  FROM public.agent_ops_report_expected(p_from, v_asof) e WHERE e.agent_id = p_agent_id;

  SELECT
    (SELECT COUNT(*) FROM public.rent_requests rr WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id) AND rr.status IN ('funded','repaying','completed')) AS assigned_tenants,
    (SELECT COUNT(*) FROM public.rent_requests rr WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id) AND rr.status IN ('funded','repaying')) AS active_repaying,
    (SELECT COALESCE(SUM(rr.rent_amount),0) FROM public.rent_requests rr WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id) AND rr.status IN ('funded','repaying','completed')) AS rent_total,
    (SELECT COALESCE(SUM(rr.total_repayment),0) FROM public.rent_requests rr WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id) AND rr.status IN ('funded','repaying','completed')) AS repayment_total,
    (SELECT COALESCE(SUM(rr.amount_repaid),0) FROM public.rent_requests rr WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id) AND rr.status IN ('funded','repaying','completed')) AS repaid_total,
    (SELECT COALESCE(SUM(LEAST(COALESCE(c.paid, 0), b.expected_window)),0)
       FROM bill b LEFT JOIN coll_raw c ON c.rent_request_id = b.rent_request_id) AS collected_window,
    (SELECT COUNT(*) FROM public.agent_collections ac WHERE ac.reversed_at IS NULL AND ac.agent_id = p_agent_id AND ac.amount > 0 AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to) AS payments_window
  INTO v_k;

  RETURN jsonb_build_object(
    'agent', COALESCE(v_agent,'{}'::jsonb),
    'range', jsonb_build_object('from', p_from, 'to', p_to, 'as_of', v_asof),
    'basis', 'tenant_ops_home_capped_schedule',
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
$function$;

REVOKE ALL ON FUNCTION public.agent_ops_report_agent(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_ops_report_agent(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_ops_report_agent(uuid, date, date) TO service_role;