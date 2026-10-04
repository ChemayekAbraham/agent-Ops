CREATE OR REPLACE FUNCTION public.ops_tenant_ops_tool_counts()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_res jsonb;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  v_day_start := (date_trunc('day', (now() AT TIME ZONE 'Africa/Kampala')) AT TIME ZONE 'Africa/Kampala');
  v_day_end := v_day_start + interval '1 day';

  WITH active AS (
    -- Active plans. `disbursed_at` is unreliable (most repaying plans never got
    -- one), so the repayment clock is anchored on the first available of
    -- disbursed_at -> funded_at -> created_at.
    SELECT
      rr.tenant_id,
      COALESCE(rr.daily_repayment, 0) AS daily_repayment,
      COALESCE(rr.amount_repaid, 0) AS amount_repaid,
      COALESCE(rr.total_repayment, 0) AS total_repayment,
      COALESCE(rr.disbursed_at, rr.funded_at, rr.created_at) AS start_at,
      row_number() OVER (
        PARTITION BY rr.tenant_id
        ORDER BY (COALESCE(rr.total_repayment,0) - COALESCE(rr.amount_repaid,0)) DESC, rr.created_at DESC
      ) AS rn
    FROM rent_requests rr
    WHERE rr.status IN ('funded','disbursed','repaying')
      AND rr.tenant_id IS NOT NULL
  ),
  -- One row per tenant (the plan with the largest outstanding balance), which is
  -- exactly how the Missed Days / Daily Payments tools de-duplicate tenants.
  pick AS (SELECT * FROM active WHERE rn = 1),
  missed AS (
    SELECT
      p.tenant_id,
      p.daily_repayment,
      CASE WHEN p.daily_repayment > 0 THEN
        GREATEST(0, round((
          LEAST(p.daily_repayment * GREATEST(1, (date_part('day', now() - p.start_at))::int), p.total_repayment)
          - p.amount_repaid
        ) / p.daily_repayment))
      ELSE 0 END AS missed_days
    FROM pick p
  ),
  today_coll AS (
    SELECT ac.tenant_id, sum(ac.amount) AS amt, count(*) AS entries
    FROM agent_collections ac
    WHERE ac.created_at >= v_day_start AND ac.created_at < v_day_end
    GROUP BY ac.tenant_id
  ),
  behavior AS (SELECT * FROM public.get_tenant_behavior_segments())
  SELECT jsonb_build_object(
    'review_requests', (
      -- Only what the Tenant Ops review queue actually renders.
      SELECT count(*) FROM rent_requests rr
      WHERE rr.status IN ('agent_ops_approved','agent_verified')
    ),
    'new_requests', (SELECT count(*) FROM rent_requests rr WHERE rr.status = 'pending'),
    'service_center_review', (SELECT count(*) FROM rent_requests rr WHERE rr.status = 'service_center_review'),
    'active_plans', (SELECT count(*) FROM rent_requests rr WHERE rr.status IN ('funded','disbursed','repaying')),
    'repaying_plans', (SELECT count(*) FROM rent_requests rr WHERE rr.status = 'repaying'),
    'tenant_count', (SELECT count(DISTINCT rr.tenant_id) FROM rent_requests rr WHERE rr.tenant_id IS NOT NULL),
    'active_tenants', (SELECT count(*) FROM pick),
    'payments_today', (SELECT COALESCE(sum(tc.entries), 0) FROM today_coll tc),
    'collected_today', (SELECT COALESCE(sum(tc.amt), 0) FROM today_coll tc),
    'expected_today', (
      SELECT COALESCE(sum(p.daily_repayment), 0) FROM pick p
      WHERE p.amount_repaid < p.total_repayment
    ),
    'tenants_paid_today', (SELECT count(*) FROM today_coll),
    -- Tenants counted as "paid today" by the Daily Payments tool: at least half
    -- of the daily amount received today.
    'paid_today_tenants', (
      SELECT count(*) FROM pick p
      JOIN today_coll tc ON tc.tenant_id = p.tenant_id
      WHERE tc.amt >= p.daily_repayment * 0.5
    ),
    'unpaid_today_tenants', (
      SELECT count(*) FROM pick p
      LEFT JOIN today_coll tc ON tc.tenant_id = p.tenant_id
      WHERE COALESCE(tc.amt, 0) < p.daily_repayment * 0.5
    ),
    -- Missed Days tool: warning (>=2) and critical (>=5) thresholds.
    'missed_days_tenants', (SELECT count(*) FROM missed WHERE missed_days >= 2),
    'critical_tenants', (SELECT count(*) FROM missed WHERE missed_days >= 5),
    -- Tenant Behavior tool uses its own risk model.
    'behavior_critical', (SELECT critical_count FROM behavior),
    'behavior_warning', (SELECT warning_count FROM behavior),
    'transfers_30d', (SELECT count(*) FROM tenant_transfers tt WHERE tt.created_at >= now() - interval '30 days'),
    'approvals_today', (
      SELECT count(*) FROM rent_requests rr
      WHERE (rr.tenant_ops_reviewed_at >= v_day_start AND rr.tenant_ops_reviewed_at < v_day_end)
         OR (rr.agent_verified_at >= v_day_start AND rr.agent_verified_at < v_day_end)
         OR (rr.landlord_ops_reviewed_at >= v_day_start AND rr.landlord_ops_reviewed_at < v_day_end)
         OR (rr.coo_reviewed_at >= v_day_start AND rr.coo_reviewed_at < v_day_end)
         OR (rr.cfo_reviewed_at >= v_day_start AND rr.cfo_reviewed_at < v_day_end)
    ),
    'rejected_30d', (
      SELECT count(*) FROM rent_requests rr
      WHERE rr.status = 'rejected' AND COALESCE(rr.rejected_at, rr.updated_at) >= now() - interval '30 days'
    ),
    'generated_at', to_jsonb(now())
  ) INTO v_res;

  RETURN v_res;
END;
$function$;

REVOKE ALL ON FUNCTION public.ops_tenant_ops_tool_counts() FROM public;
GRANT EXECUTE ON FUNCTION public.ops_tenant_ops_tool_counts() TO authenticated, service_role;