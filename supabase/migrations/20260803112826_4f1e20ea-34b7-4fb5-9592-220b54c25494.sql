CREATE OR REPLACE FUNCTION public.get_tenant_ops_agent_360(p_agent_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  SELECT jsonb_build_object(
    'profile', (
      SELECT jsonb_build_object(
        'id', pr.id, 'full_name', pr.full_name, 'phone', pr.phone, 'email', pr.email,
        'avatar_url', pr.avatar_url, 'created_at', pr.created_at,
        'country', pr.country, 'region', pr.region, 'district', pr.district, 'ward', pr.sub_county
      ) FROM profiles pr WHERE pr.id = p_agent_id
    ),
    'tenants', (
      SELECT jsonb_build_object(
        'total', count(*),
        'active', count(*) FILTER (WHERE d.is_active),
        'inactive', count(*) FILTER (WHERE NOT COALESCE(d.is_active,false)),
        'new_month', count(*) FILTER (WHERE d.tenant_created_at >= date_trunc('month', v_today)),
        'billable_today', count(*) FILTER (WHERE d.is_billable_today),
        'settled_today', count(*) FILTER (WHERE d.is_billable_today AND d.daily_repayment > 0 AND d.paid_today >= d.daily_repayment),
        'partial_today', count(*) FILTER (WHERE d.is_billable_today AND d.paid_today > 0 AND (d.daily_repayment = 0 OR d.paid_today < d.daily_repayment)),
        'covered_by_advance', count(*) FILTER (WHERE d.is_billable_today AND d.paid_today = 0 AND d.is_prepaid_today),
        'uncollected_today', count(*) FILTER (WHERE d.is_billable_today AND d.paid_today = 0 AND NOT d.is_prepaid_today),
        'overdue', count(*) FILTER (WHERE d.is_active AND d.arrears_amount > 0),
        'arrears', count(*) FILTER (WHERE d.arrears_amount > 0),
        'par_current', count(*) FILTER (WHERE d.is_active AND d.days_behind <= 0),
        'par_1_7', count(*) FILTER (WHERE d.is_active AND d.days_behind BETWEEN 1 AND 7),
        'par_8_30', count(*) FILTER (WHERE d.is_active AND d.days_behind BETWEEN 8 AND 30),
        'par_31_60', count(*) FILTER (WHERE d.is_active AND d.days_behind BETWEEN 31 AND 60),
        'par_60_plus', count(*) FILTER (WHERE d.is_active AND d.days_behind > 60),
        'par_amount_30_plus', COALESCE(sum(d.arrears_amount) FILTER (WHERE d.is_active AND d.days_behind > 30),0),
        'avg_days_behind', COALESCE(avg(d.days_behind) FILTER (WHERE d.is_active AND d.days_behind > 0),0),
        'paid_early', count(*) FILTER (WHERE d.is_active AND d.schedule_delta_days > 0),
        'paid_on_time', count(*) FILTER (WHERE d.is_active AND d.schedule_delta_days = 0),
        'paid_late', count(*) FILTER (WHERE d.is_active AND d.schedule_delta_days < 0),
        'expiring_leases', count(*) FILTER (WHERE d.lease_end_date BETWEEN v_today AND v_today + 30),
        'ended_leases', count(*) FILTER (WHERE d.tenancy_status = 'ended'),
        'high_risk', count(*) FILTER (WHERE d.daily_repayment > 0 AND d.arrears_amount >= d.daily_repayment * 14),
        'medium_risk', count(*) FILTER (WHERE d.daily_repayment > 0 AND d.arrears_amount >= d.daily_repayment * 5 AND d.arrears_amount < d.daily_repayment * 14),
        'low_risk', count(*) FILTER (WHERE COALESCE(d.arrears_amount,0) < COALESCE(d.daily_repayment,0) * 5),
        'exposure_at_risk', COALESCE(sum(d.outstanding) FILTER (WHERE d.daily_repayment > 0 AND d.arrears_amount >= d.daily_repayment * 5), 0)
      ) FROM (
        SELECT b.*,
          (b.is_active AND b.outstanding > 0) AS is_billable_today,
          (b.daily_repayment > 0 AND b.advance_amount >= b.daily_repayment) AS is_prepaid_today,
          CASE WHEN b.daily_repayment > 0 THEN ceil(b.arrears_amount / b.daily_repayment)::int ELSE 0 END AS days_behind
        FROM v_tenant_ops_tenant_base b WHERE b.agent_id = p_agent_id
      ) d
    ),
    'financials', (
      SELECT jsonb_build_object(
        'portfolio_value', COALESCE(sum(b.total_repayment),0),
        'rent_expected_monthly', COALESCE(sum(b.daily_repayment) FILTER (WHERE b.is_active),0) * 30,
        'expected_today', COALESCE(sum(LEAST(b.daily_repayment, b.outstanding)) FILTER (WHERE b.is_active AND b.outstanding > 0),0),
        'expected_to_date', COALESCE(sum(b.expected_to_date),0),
        'collected_to_date', COALESCE(sum(b.amount_repaid),0),
        'outstanding', COALESCE(sum(b.outstanding),0),
        'arrears', COALESCE(sum(b.arrears_amount),0),
        'advances', COALESCE(sum(b.advance_amount),0),
        'paid_today', COALESCE(sum(b.paid_today),0),
        'paid_week', COALESCE(sum(b.paid_week),0),
        'paid_month', COALESCE(sum(b.paid_month),0),
        'paid_quarter', COALESCE(sum(b.paid_quarter),0),
        'paid_year', COALESCE(sum(b.paid_year),0),
        'avg_rent', COALESCE(avg(NULLIF(b.rent_amount,0)),0)
      ) FROM v_tenant_ops_tenant_base b WHERE b.agent_id = p_agent_id
    ),
    'properties', (
      SELECT jsonb_build_object(
        'total', count(*),
        'occupied', count(*) FILTER (WHERE pb.is_occupied),
        'vacant', count(*) FILTER (WHERE NOT pb.is_occupied),
        'portfolio_rent', COALESCE(sum(pb.monthly_rent),0),
        'avg_rent', COALESCE(avg(NULLIF(pb.monthly_rent,0)),0),
        'new_month', count(*) FILTER (WHERE pb.created_at >= date_trunc('month', v_today))
      ) FROM v_tenant_ops_property_base pb WHERE pb.agent_id = p_agent_id
    ),
    'landlords', (
      SELECT jsonb_build_object(
        'total', count(*),
        'verified', count(*) FILTER (WHERE lb.verified),
        'new_month', count(*) FILTER (WHERE lb.created_at >= date_trunc('month', v_today))
      ) FROM v_tenant_ops_landlord_base lb WHERE lb.agent_id = p_agent_id
    ),
    'collections', (
      SELECT jsonb_build_object(
        'today', COALESCE(sum(ac.amount) FILTER (WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date = v_today),0),
        'week', COALESCE(sum(ac.amount) FILTER (WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date >= date_trunc('week', v_today)::date),0),
        'month', COALESCE(sum(ac.amount) FILTER (WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date >= date_trunc('month', v_today)::date),0),
        'quarter', COALESCE(sum(ac.amount) FILTER (WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date >= date_trunc('quarter', v_today)::date),0),
        'year', COALESCE(sum(ac.amount) FILTER (WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date >= date_trunc('year', v_today)::date),0),
        'count_month', count(*) FILTER (WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date >= date_trunc('month', v_today)::date)
      ) FROM agent_collections ac WHERE ac.agent_id = p_agent_id
    ),
    'commissions', (
      SELECT jsonb_build_object(
        'earned', COALESCE(sum(c.amount),0),
        'paid', COALESCE(sum(c.amount) FILTER (WHERE c.status = 'paid'),0),
        'pending', COALESCE(sum(c.amount) FILTER (WHERE c.status IN ('pending','approved')),0),
        'count', count(*)
      ) FROM commission_accrual_ledger c WHERE c.agent_id = p_agent_id
    ),
    'wallet', (
      SELECT jsonb_build_object(
        'balance', COALESCE(w.balance,0),
        'withdrawable', COALESCE(w.withdrawable_balance,0),
        'float', COALESCE(w.float_balance,0),
        'advance', COALESCE(w.advance_balance,0)
      ) FROM wallets w WHERE w.user_id = p_agent_id
    ),
    'withdrawals', (
      SELECT jsonb_build_object(
        'total', COALESCE(sum(wr.amount),0),
        'completed', COALESCE(sum(wr.amount) FILTER (WHERE wr.status = 'completed'),0),
        'pending', COALESCE(sum(wr.amount) FILTER (WHERE wr.status NOT IN ('completed','rejected','failed')),0),
        'failed', COALESCE(sum(wr.amount) FILTER (WHERE wr.status IN ('rejected','failed')),0),
        'count', count(*)
      ) FROM withdrawal_requests wr WHERE wr.user_id = p_agent_id
    ),
    'tenant_list', (
      SELECT COALESCE(jsonb_agg(x ORDER BY x->>'tenant_name'), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
          'tenant_id', b.tenant_id, 'tenant_name', b.tenant_name, 'phone', b.tenant_phone,
          'district', b.district, 'region', b.region,
          'rent_amount', b.rent_amount, 'total_repayment', b.total_repayment,
          'amount_repaid', b.amount_repaid, 'outstanding', b.outstanding,
          'arrears', b.arrears_amount, 'advance', b.advance_amount,
          'daily_repayment', b.daily_repayment, 'next_due_date', b.next_due_date,
          'lease_end_date', b.lease_end_date, 'status', b.rr_status,
          'schedule_delta_days', b.schedule_delta_days, 'last_payment_at', b.last_payment_at,
          'is_active', b.is_active,
          'paid_today', b.paid_today,
          'billable_today', (b.is_active AND b.outstanding > 0),
          'days_behind', CASE WHEN b.daily_repayment > 0 THEN ceil(b.arrears_amount / b.daily_repayment)::int ELSE 0 END
        ) AS x
        FROM v_tenant_ops_tenant_base b WHERE b.agent_id = p_agent_id LIMIT 500
      ) s
    ),
    'landlord_list', (
      SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
          'landlord_id', lb.landlord_id, 'name', lb.landlord_name, 'phone', lb.phone,
          'verified', lb.verified, 'district', lb.district, 'monthly_rent', lb.monthly_rent
        ) AS x
        FROM v_tenant_ops_landlord_base lb WHERE lb.agent_id = p_agent_id LIMIT 300
      ) s
    ),
    'property_list', (
      SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
          'listing_id', pb.listing_id, 'district', pb.district, 'region', pb.region,
          'monthly_rent', pb.monthly_rent, 'occupied', pb.is_occupied,
          'verified', pb.verified, 'status', pb.status
        ) AS x
        FROM v_tenant_ops_property_base pb WHERE pb.agent_id = p_agent_id LIMIT 300
      ) s
    ),
    'collection_trend', (
      SELECT COALESCE(jsonb_agg(x ORDER BY x->>'day'), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
          'day', d.day,
          'collected', COALESCE((SELECT sum(ac.amount) FROM agent_collections ac
             WHERE ac.agent_id = p_agent_id
               AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date = d.day), 0)
        ) AS x
        FROM generate_series(v_today - 29, v_today, interval '1 day') AS g(day)
        CROSS JOIN LATERAL (SELECT g.day::date AS day) d
      ) s
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;