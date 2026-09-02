CREATE OR REPLACE FUNCTION public.ops_tenant_ops_home_range(p_start timestamptz, p_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_start timestamptz;
  v_end timestamptz;
  v_days int;
  v_res jsonb;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;
  v_start := (date_trunc('day', (p_start AT TIME ZONE 'Africa/Kampala')) AT TIME ZONE 'Africa/Kampala');
  v_end := (date_trunc('day', (p_end AT TIME ZONE 'Africa/Kampala')) AT TIME ZONE 'Africa/Kampala') + interval '1 day';
  v_days := GREATEST(1, ((v_end - v_start) / interval '1 day')::int);
  WITH active AS (
    SELECT e.tenant_id, e.daily_repayment, e.amount_repaid, e.total_repayment, e.start_at,
      row_number() OVER (PARTITION BY e.tenant_id ORDER BY (e.total_repayment - e.amount_repaid) DESC, e.start_at DESC) AS rn
    FROM public.v_tenant_daily_eligibility e
  ), pick AS (SELECT * FROM active WHERE rn = 1),
  window_coll AS (
    SELECT ac.tenant_id, sum(ac.amount) AS amt, count(*) AS entries
    FROM public.agent_collections ac WHERE ac.created_at >= v_start AND ac.created_at < v_end GROUP BY ac.tenant_id
  ), missed AS (
    SELECT p.tenant_id, CASE WHEN p.daily_repayment > 0 THEN GREATEST(0, round((LEAST(p.daily_repayment * GREATEST(1, (date_part('day', now() - p.start_at))::int), p.total_repayment) - p.amount_repaid) / p.daily_repayment)) ELSE 0 END AS missed_days
    FROM pick p
  ), behavior AS (SELECT * FROM public.get_tenant_behavior_segments())
  SELECT jsonb_build_object(
    'days', v_days, 'window_start', to_jsonb(v_start), 'window_end', to_jsonb(v_end),
    'collected', (SELECT COALESCE(sum(wc.amt), 0) FROM window_coll wc),
    'payments', (SELECT COALESCE(sum(wc.entries), 0) FROM window_coll wc),
    'tenants_paid', (SELECT count(*) FROM window_coll),
    'expected', (SELECT COALESCE(sum(p.daily_repayment), 0) * v_days FROM pick p),
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
REVOKE ALL ON FUNCTION public.ops_tenant_ops_home_range(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ops_tenant_ops_home_range(timestamptz, timestamptz) TO authenticated;