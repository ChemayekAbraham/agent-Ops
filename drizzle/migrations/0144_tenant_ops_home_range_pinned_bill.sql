CREATE OR REPLACE FUNCTION public.ops_tenant_ops_home_range(p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_start timestamptz;
  v_end timestamptz;
  v_days int;
  v_d1 date;
  v_d2 date;
  v_today date;
  v_asof date;
  v_expected numeric := 0;
  v_res jsonb;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;
  v_start := (date_trunc('day', (p_start AT TIME ZONE 'Africa/Kampala')) AT TIME ZONE 'Africa/Kampala');
  v_end := (date_trunc('day', (p_end AT TIME ZONE 'Africa/Kampala')) AT TIME ZONE 'Africa/Kampala') + interval '1 day';
  v_days := GREATEST(1, round(extract(epoch FROM (v_end - v_start)) / 86400)::int);

  v_today := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_d1 := (v_start AT TIME ZONE 'Africa/Kampala')::date;
  v_d2 := ((v_end - interval '1 microsecond') AT TIME ZONE 'Africa/Kampala')::date;
  v_asof := LEAST(v_d2, v_today);

  SELECT COALESCE(sum(p.expected_ugx), 0) INTO v_expected
  FROM public.agent_expected_day_plans p
  WHERE p.day BETWEEN v_d1 AND v_asof;

  WITH active AS (
    SELECT e.tenant_id, e.daily_repayment, e.amount_repaid, e.total_repayment, e.start_at,
      row_number() OVER (PARTITION BY e.tenant_id ORDER BY (e.total_repayment - e.amount_repaid) DESC, e.start_at DESC) AS rn
    FROM public.v_tenant_daily_eligibility e
  ), pick AS (SELECT * FROM active WHERE rn = 1),
  window_coll AS (
    SELECT ac.tenant_id, sum(ac.amount) AS amt, count(*) AS entries
    FROM (SELECT * FROM public.agent_collections WHERE reversed_at IS NULL) ac WHERE ac.created_at >= v_start AND ac.created_at < v_end GROUP BY ac.tenant_id
  ),
  bill_amt AS (
    SELECT p.rent_request_id, sum(p.expected_ugx) AS expected_ugx
    FROM public.agent_expected_day_plans p
    WHERE p.day BETWEEN v_d1 AND v_asof
    GROUP BY p.rent_request_id
  ),
  cash AS (
    SELECT ac.rent_request_id, ac.amount
    FROM public.agent_collections ac
    WHERE ac.created_at >= v_start AND ac.created_at < v_end
      AND ac.amount > 0 AND ac.reversed_at IS NULL
  ),
  capped AS (
    SELECT COALESCE(sum(LEAST(COALESCE(c.paid, 0), b.expected_ugx)), 0) AS on_schedule_capped,
           COALESCE(sum(b.expected_ugx - LEAST(COALESCE(c.paid, 0), b.expected_ugx)), 0) AS pending_capped
    FROM bill_amt b
    LEFT JOIN (SELECT rent_request_id, sum(amount) AS paid FROM cash WHERE rent_request_id IS NOT NULL GROUP BY rent_request_id) c
           ON c.rent_request_id = b.rent_request_id
  ), missed AS (
    SELECT p.tenant_id, CASE WHEN p.daily_repayment > 0 THEN GREATEST(0, round((LEAST(p.daily_repayment * GREATEST(1, (date_part('day', now() - p.start_at))::int), p.total_repayment) - p.amount_repaid) / p.daily_repayment)) ELSE 0 END AS missed_days
    FROM pick p
  ), behavior AS (SELECT * FROM public.get_tenant_behavior_segments())
  SELECT jsonb_build_object(
    'days', v_days, 'window_start', to_jsonb(v_start), 'window_end', to_jsonb(v_end),
    'collected', (SELECT on_schedule_capped FROM capped),
    'collected_total', (SELECT COALESCE(sum(wc.amt), 0) FROM window_coll wc),
    'pending', (SELECT pending_capped FROM capped),
    'payments', (SELECT COALESCE(sum(wc.entries), 0) FROM window_coll wc),
    'tenants_paid', (SELECT count(*) FROM window_coll),
    'expected', v_expected,
    'expected_basis', 'pinned_schedule',
    'paid_tenants', (SELECT count(*) FROM pick p JOIN window_coll wc ON wc.tenant_id = p.tenant_id WHERE wc.amt >= p.daily_repayment * v_days * 0.5),
    'unpaid_tenants', (SELECT count(*) FROM pick p LEFT JOIN window_coll wc ON wc.tenant_id = p.tenant_id WHERE COALESCE(wc.amt, 0) < p.daily_repayment * v_days * 0.5),
    'tenant_count', (SELECT count(DISTINCT rr.tenant_id) FROM public.rent_requests rr WHERE rr.tenant_id IS NOT NULL AND rr.created_at < v_end),
    'active_tenants', (SELECT count(*) FROM pick),
    'review_requests', (SELECT count(*) FROM public.rent_requests rr WHERE rr.status IN ('agent_ops_approved','agent_verified') AND rr.created_at >= v_start AND rr.created_at < v_end),
    'new_requests', (SELECT count(*) FROM public.rent_requests rr WHERE rr.status = 'pending' AND rr.created_at >= v_start AND rr.created_at < v_end),
    'service_center_review', (SELECT count(*) FROM public.rent_requests rr WHERE rr.status = 'service_center_review' AND rr.created_at >= v_start AND rr.created_at < v_end),
    'approvals', (SELECT count(*) FROM public.rent_requests rr WHERE (rr.tenant_ops_reviewed_at >= v_start AND rr.tenant_ops_reviewed_at < v_end) OR (rr.agent_verified_at >= v_start AND rr.agent_verified_at < v_end) OR (rr.landlord_ops_reviewed_at >= v_start AND rr.landlord_ops_reviewed_at < v_end) OR (rr.coo_reviewed_at >= v_start AND rr.coo_reviewed_at < v_end) OR (rr.cfo_reviewed_at >= v_start AND rr.cfo_reviewed_at < v_end)),
    'rejected', (SELECT count(*) FROM public.rent_requests rr WHERE rr.status = 'rejected' AND COALESCE(rr.rejected_at, rr.updated_at) >= v_start AND COALESCE(rr.rejected_at, rr.updated_at) < v_end),
    'transfers', (SELECT count(*) FROM public.tenant_transfers tt WHERE tt.created_at >= v_start AND tt.created_at < v_end),
    'warning_behaviour', COALESCE((SELECT warning_count FROM behavior), 0),
    'critical_behaviour', COALESCE((SELECT critical_count FROM behavior), 0),
    'missed_days_tenants', (SELECT count(*) FROM missed WHERE missed_days >= 2),
    'critical_tenants', (SELECT count(*) FROM missed WHERE missed_days >= 5),
    'generated_at', to_jsonb(now())
  ) INTO v_res;
  RETURN v_res;
END;
$function$;