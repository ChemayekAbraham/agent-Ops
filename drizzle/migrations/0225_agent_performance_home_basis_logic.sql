CREATE OR REPLACE FUNCTION public.agent_performance_home_basis_range(p_start timestamptz, p_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_start timestamptz;
  v_end timestamptz;
  v_d1 date;
  v_d2 date;
  v_today date;
  v_asof date;
  v_days int;
  v_bill_days int;
  v_rows jsonb;
  v_totals record;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF p_start IS NULL OR p_end IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;

  v_start := (date_trunc('day', (p_start AT TIME ZONE 'Africa/Kampala')) AT TIME ZONE 'Africa/Kampala');
  v_end := (date_trunc('day', (p_end AT TIME ZONE 'Africa/Kampala')) AT TIME ZONE 'Africa/Kampala') + interval '1 day';
  IF v_end <= v_start THEN v_end := v_start + interval '1 day'; END IF;

  v_today := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_d1 := (v_start AT TIME ZONE 'Africa/Kampala')::date;
  v_d2 := ((v_end - interval '1 microsecond') AT TIME ZONE 'Africa/Kampala')::date;
  v_asof := LEAST(v_d2, v_today);
  v_days := GREATEST(1, round(extract(epoch FROM (v_end - v_start)) / 86400)::int);
  v_bill_days := CASE WHEN v_asof >= v_d1 THEN GREATEST(1, (v_asof - v_d1 + 1)) ELSE 1 END;

  WITH bill_by_plan AS (
    SELECT p.agent_id, p.rent_request_id, p.tenant_id, sum(p.expected_ugx)::numeric AS expected
    FROM public.agent_expected_day_plans p
    WHERE p.day BETWEEN v_d1 AND v_asof
      AND p.agent_id IS NOT NULL
    GROUP BY p.agent_id, p.rent_request_id, p.tenant_id
  ), cash_by_plan AS (
    SELECT ac.rent_request_id,
           sum(ac.amount)::numeric AS paid,
           count(*)::int AS payments,
           max(ac.created_at) AS last_at
    FROM public.agent_collections ac
    WHERE ac.created_at >= v_start
      AND ac.created_at < v_end
      AND ac.amount > 0
      AND ac.reversed_at IS NULL
      AND ac.rent_request_id IS NOT NULL
    GROUP BY ac.rent_request_id
  ), scheduled_plan AS (
    SELECT b.agent_id,
           b.tenant_id,
           b.expected,
           LEAST(COALESCE(c.paid, 0), b.expected)::numeric AS collected,
           COALESCE(c.payments, 0)::int AS payments,
           c.last_at
    FROM bill_by_plan b
    LEFT JOIN cash_by_plan c ON c.rent_request_id = b.rent_request_id
  ), schedule_by_agent AS (
    SELECT sp.agent_id,
           sum(sp.expected)::numeric AS expected,
           sum(sp.collected)::numeric AS collected,
           GREATEST(sum(sp.expected) - sum(sp.collected), 0)::numeric AS gap,
           count(DISTINCT sp.tenant_id)::int AS tenants_total,
           count(DISTINCT sp.tenant_id) FILTER (WHERE sp.collected > 0)::int AS tenants_paid,
           sum(sp.payments)::int AS payments,
           max(sp.last_at) AS last_collection_at
    FROM scheduled_plan sp
    GROUP BY sp.agent_id
  ), earnings_by_agent AS (
    SELECT e.agent_id,
           COALESCE(sum(e.amount) FILTER (WHERE lower(COALESCE(e.earning_type, '')) LIKE '%interest%'), 0)::numeric AS interest,
           COALESCE(sum(e.amount) FILTER (WHERE lower(COALESCE(e.earning_type, '')) LIKE '%commission%'), 0)::numeric AS commission
    FROM public.agent_earnings e
    WHERE e.created_at >= v_start
      AND e.created_at < v_end
      AND e.agent_id IS NOT NULL
    GROUP BY e.agent_id
  ), payout_by_agent AS (
    SELECT lp.agent_id,
           COALESCE(sum(lp.amount), 0)::numeric AS rent_paid_out
    FROM public.landlord_payouts lp
    WHERE COALESCE(lp.disbursed_at, lp.created_at) >= v_start
      AND COALESCE(lp.disbursed_at, lp.created_at) < v_end
      AND lp.agent_id IS NOT NULL
      AND (lower(COALESCE(lp.status, '')) IN ('disbursed', 'completed', 'paid', 'success') OR lp.disbursed_at IS NOT NULL)
    GROUP BY lp.agent_id
  ), ids AS (
    SELECT agent_id FROM schedule_by_agent
    UNION SELECT agent_id FROM earnings_by_agent
    UNION SELECT agent_id FROM payout_by_agent
  ), scored AS (
    SELECT i.agent_id,
           COALESCE(NULLIF(trim(p.full_name), ''), p.phone, 'Agent ' || left(i.agent_id::text, 6)) AS agent_name,
           COALESCE(s.tenants_paid, 0)::int AS tenants_paid,
           COALESCE(s.tenants_total, 0)::int AS tenants_total,
           COALESCE(s.expected, 0)::numeric AS expected,
           COALESCE(s.collected, 0)::numeric AS collected,
           COALESCE(s.payments, 0)::int AS payments,
           COALESCE(s.gap, 0)::numeric AS gap,
           COALESCE(e.interest, 0)::numeric AS interest,
           COALESCE(e.commission, 0)::numeric AS commission_earned,
           COALESCE(po.rent_paid_out, 0)::numeric AS rent_paid_out,
           CASE WHEN COALESCE(s.expected, 0) > 0 THEN round(COALESCE(s.collected, 0) * 100.0 / s.expected, 1) ELSE NULL END AS efficiency
    FROM ids i
    LEFT JOIN schedule_by_agent s ON s.agent_id = i.agent_id
    LEFT JOIN earnings_by_agent e ON e.agent_id = i.agent_id
    LEFT JOIN payout_by_agent po ON po.agent_id = i.agent_id
    LEFT JOIN public.profiles p ON p.id = i.agent_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'agent_id', s.agent_id,
           'agent_name', s.agent_name,
           'tenants_paid', s.tenants_paid,
           'tenants_total', s.tenants_total,
           'pct_paid', CASE WHEN s.tenants_total > 0 THEN round(s.tenants_paid * 100.0 / s.tenants_total, 1) ELSE 0 END,
           'collected', s.collected,
           'expected', s.expected,
           'payments', s.payments,
           'commission', CASE WHEN s.commission_earned > 0 THEN s.commission_earned ELSE round(s.collected * 0.10, 0) END,
           'interest', s.interest,
           'wallet_total', (CASE WHEN s.commission_earned > 0 THEN s.commission_earned ELSE round(s.collected * 0.10, 0) END) + s.interest,
           'rate', CASE WHEN s.collected > 0 THEN (((CASE WHEN s.commission_earned > 0 THEN s.commission_earned ELSE round(s.collected * 0.10, 0) END) + s.interest) * 100.0 / s.collected) ELSE 0 END,
           'daily_portfolio', CASE WHEN v_bill_days > 0 THEN round(s.expected / v_bill_days, 0) ELSE 0 END,
           'expected_period', s.expected,
           'efficiency', COALESCE(s.efficiency, 0),
           'gap', s.gap,
           'daily_collection', CASE WHEN v_bill_days > 0 THEN round(s.collected / v_bill_days, 0) ELSE 0 END,
           'daily_commission', CASE WHEN v_bill_days > 0 THEN round((CASE WHEN s.commission_earned > 0 THEN s.commission_earned ELSE round(s.collected * 0.10, 0) END) / v_bill_days, 0) ELSE 0 END,
           'rent_paid_out', s.rent_paid_out,
           'conversion_pct', CASE WHEN s.tenants_total > 0 THEN round(s.tenants_paid * 100.0 / s.tenants_total, 1) ELSE 0 END,
           'status', CASE
             WHEN COALESCE(s.efficiency, 0) >= 100 THEN 'excellent'
             WHEN COALESCE(s.efficiency, 0) >= 80 THEN 'good'
             WHEN COALESCE(s.efficiency, 0) >= 60 THEN 'moderate'
             WHEN COALESCE(s.efficiency, 0) >= 40 THEN 'low'
             ELSE 'critical' END,
           'source_breakdown', jsonb_build_object('agent_collections', s.collected, 'repayments', 0, 'merchant', 0)
         ) ORDER BY s.expected DESC, s.collected DESC, s.agent_name), '[]'::jsonb)
    INTO v_rows
  FROM scored s
  WHERE s.expected > 0 OR s.collected > 0 OR s.commission_earned > 0 OR s.interest > 0 OR s.rent_paid_out > 0;

  WITH row_values AS (
    SELECT (r->>'tenants_paid')::int AS tenants_paid,
           (r->>'tenants_total')::int AS tenants_total,
           (r->>'collected')::numeric AS collected,
           (r->>'expected_period')::numeric AS expected,
           (r->>'payments')::int AS payments,
           (r->>'commission')::numeric AS commission,
           (r->>'interest')::numeric AS interest,
           (r->>'wallet_total')::numeric AS wallet_total,
           (r->>'daily_portfolio')::numeric AS daily_portfolio,
           (r->>'gap')::numeric AS gap,
           (r->>'daily_collection')::numeric AS daily_collection,
           (r->>'daily_commission')::numeric AS daily_commission,
           (r->>'rent_paid_out')::numeric AS rent_paid_out
    FROM jsonb_array_elements(v_rows) r
  )
  SELECT COALESCE(sum(collected), 0)::numeric AS collected,
         COALESCE(sum(expected), 0)::numeric AS expected,
         COALESCE(sum(payments), 0)::int AS payments,
         COALESCE(sum(commission), 0)::numeric AS commission,
         COALESCE(sum(interest), 0)::numeric AS interest,
         COALESCE(sum(wallet_total), 0)::numeric AS wallet_total,
         COALESCE(sum(tenants_paid), 0)::int AS tenants_paid,
         COALESCE(sum(tenants_total), 0)::int AS tenants_total,
         COALESCE(sum(daily_portfolio), 0)::numeric AS daily_portfolio,
         COALESCE(sum(gap), 0)::numeric AS gap,
         COALESCE(sum(daily_collection), 0)::numeric AS daily_collection,
         COALESCE(sum(daily_commission), 0)::numeric AS daily_commission,
         COALESCE(sum(rent_paid_out), 0)::numeric AS rent_paid_out
    INTO v_totals
  FROM row_values;

  RETURN jsonb_build_object(
    'range', jsonb_build_object('window_start', v_start, 'window_end', v_end, 'from_day', v_d1, 'to_day', v_d2, 'as_of_day', v_asof, 'days', v_days, 'bill_days', v_bill_days),
    'basis', 'tenant_ops_home_capped_schedule',
    'rows', v_rows,
    'totals', jsonb_build_object(
      'collected', v_totals.collected,
      'expected', v_totals.expected,
      'payments', v_totals.payments,
      'commission', v_totals.commission,
      'interest', v_totals.interest,
      'wallet_total', v_totals.wallet_total,
      'tenants_paid', v_totals.tenants_paid,
      'tenants_total', v_totals.tenants_total,
      'daily_portfolio', v_totals.daily_portfolio,
      'expected_period', v_totals.expected,
      'gap', v_totals.gap,
      'daily_collection', v_totals.daily_collection,
      'daily_commission', v_totals.daily_commission,
      'rent_paid_out', v_totals.rent_paid_out,
      'efficiency', CASE WHEN v_totals.expected > 0 THEN round(v_totals.collected * 100.0 / v_totals.expected, 1) ELSE 0 END
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.agent_performance_home_basis_range(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_performance_home_basis_range(timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_performance_home_basis_range(timestamptz, timestamptz) TO service_role;

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
           COALESCE(c.collected_window,0) AS collected_window,
           COALESCE(c.payments,0) AS payments, c.last_at, h.history, h.truncated,
           CASE WHEN COALESCE(pl.total_repayment,0) > 0
                THEN ROUND(pl.amount_repaid * 100.0 / pl.total_repayment, 1) ELSE NULL END AS percentage
    FROM plans pl
    LEFT JOIN public.profiles tp ON tp.id = pl.tenant_id
    LEFT JOIN coll c ON c.rent_request_id = pl.id
    LEFT JOIN hist h ON h.rent_request_id = pl.id
    WHERE pl.status IN ('funded','repaying') OR c.rent_request_id IS NOT NULL
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