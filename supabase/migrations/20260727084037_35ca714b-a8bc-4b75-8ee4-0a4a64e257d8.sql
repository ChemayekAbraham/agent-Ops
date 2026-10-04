
CREATE OR REPLACE FUNCTION public.get_agent_ops_overview(
  p_range_start timestamptz,
  p_range_end timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_prev_start timestamptz;
  v_prev_end timestamptz := p_range_start;
  v_span interval;
  v_result jsonb;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;
  IF NOT (
    public.is_ops_role(v_uid)
    OR public.has_role(v_uid, 'manager')
    OR public.has_role(v_uid, 'cfo')
    OR public.has_role(v_uid, 'ceo')
    OR public.has_role(v_uid, 'coo')
    OR public.has_role(v_uid, 'cto')
    OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  v_span := p_range_end - p_range_start;
  v_prev_start := p_range_start - v_span;

  WITH
  totals AS (
    SELECT
      (SELECT count(*) FROM public.user_roles WHERE role = 'agent') AS total_agents,
      (SELECT count(*) FROM public.user_roles WHERE role = 'agent' AND created_at >= p_range_start AND created_at < p_range_end) AS new_agents_curr,
      (SELECT count(*) FROM public.user_roles WHERE role = 'agent' AND created_at >= v_prev_start AND created_at < v_prev_end) AS new_agents_prev,
      (SELECT count(*) FROM public.rent_requests WHERE created_at >= p_range_start AND created_at < p_range_end) AS rent_req_curr,
      (SELECT count(*) FROM public.rent_requests WHERE created_at >= v_prev_start AND created_at < v_prev_end) AS rent_req_prev,
      (SELECT COALESCE(sum(amount_requested), 0) FROM public.rent_requests WHERE created_at >= p_range_start AND created_at < p_range_end) AS rent_req_amount_curr,
      (SELECT count(DISTINCT agent_id) FROM public.rent_requests WHERE agent_id IS NOT NULL AND created_at >= p_range_start AND created_at < p_range_end) AS active_agents_curr,
      (SELECT count(DISTINCT agent_id) FROM public.rent_requests WHERE agent_id IS NOT NULL AND created_at >= v_prev_start AND created_at < v_prev_end) AS active_agents_prev,
      (SELECT count(*) FROM public.house_listings WHERE verified = true AND verified_at >= p_range_start AND verified_at < p_range_end) AS verified_houses_curr,
      (SELECT count(*) FROM public.house_listings WHERE verified = true AND verified_at >= v_prev_start AND verified_at < v_prev_end) AS verified_houses_prev,
      (SELECT COALESCE(sum(amount), 0) FROM public.agent_collections WHERE created_at::date = v_today) AS collections_today,
      (SELECT count(*) FROM public.agent_collections WHERE created_at::date = v_today) AS collections_today_count,
      (SELECT COALESCE(sum(amount), 0) FROM public.agent_collections WHERE created_at >= p_range_start AND created_at < p_range_end) AS collections_curr,
      (SELECT COALESCE(sum(amount), 0) FROM public.agent_collections WHERE created_at >= v_prev_start AND created_at < v_prev_end) AS collections_prev,
      (SELECT COALESCE(sum(amount), 0) FROM public.general_ledger
         WHERE ledger_scope = 'wallet'
           AND direction IN ('cash_in','credit')
           AND category IN ('agent_commission_earned','agent_commission','agent_bonus','agent_investment_commission','proxy_investment_commission','partner_commission')
           AND created_at >= p_range_start AND created_at < p_range_end) AS commission_curr,
      (SELECT COALESCE(sum(amount), 0) FROM public.general_ledger
         WHERE ledger_scope = 'wallet'
           AND direction IN ('cash_in','credit')
           AND category IN ('agent_commission_earned','agent_commission','agent_bonus','agent_investment_commission','proxy_investment_commission','partner_commission')
           AND created_at >= v_prev_start AND created_at < v_prev_end) AS commission_prev,
      (SELECT COALESCE(sum(outstanding_balance), 0) FROM public.agent_advances WHERE status IN ('active','overdue')) AS outstanding_advances,
      (SELECT count(*) FROM public.agent_advances WHERE status IN ('active','overdue')) AS active_advances_count,
      (SELECT count(*) FROM public.agent_advances WHERE status = 'overdue' OR arrears_balance > 0) AS behind_advances_count,
      (SELECT count(*) FROM public.rent_requests WHERE status = 'pending_approval') AS rent_pending,
      (SELECT count(*) FROM public.rent_requests WHERE status IN ('approved','funded','disbursed')) AS rent_approved,
      (SELECT count(*) FROM public.rent_requests WHERE status = 'repaying') AS rent_repaying,
      (SELECT count(*) FROM public.rent_requests WHERE status IN ('rejected','deleted_by_agent')) AS rent_rejected
  ),
  listings_funnel AS (
    SELECT
      count(*) FILTER (WHERE created_at >= p_range_start AND created_at < p_range_end) AS listed,
      count(*) FILTER (WHERE verified = true AND verified_at >= p_range_start AND verified_at < p_range_end) AS verified,
      count(*) FILTER (WHERE tenant_id IS NOT NULL AND created_at >= p_range_start AND created_at < p_range_end) AS placed
    FROM public.house_listings
  ),
  daily_series AS (
    SELECT
      d::date AS day,
      (SELECT count(*) FROM public.user_roles ur WHERE ur.role = 'agent' AND ur.created_at::date = d::date) AS agents,
      (SELECT count(*) FROM public.rent_requests rr WHERE rr.created_at::date = d::date) AS requests,
      (SELECT COALESCE(sum(amount), 0) FROM public.agent_collections c WHERE c.created_at::date = d::date) AS collections,
      (SELECT COALESCE(sum(amount), 0) FROM public.general_ledger g
         WHERE g.ledger_scope = 'wallet'
           AND g.direction IN ('cash_in','credit')
           AND g.category IN ('agent_commission_earned','agent_commission','agent_bonus','agent_investment_commission','proxy_investment_commission','partner_commission')
           AND g.created_at::date = d::date) AS commission,
      (SELECT count(DISTINCT rr.agent_id) FROM public.rent_requests rr WHERE rr.agent_id IS NOT NULL AND rr.created_at::date = d::date) AS active_agents
    FROM generate_series(p_range_start::date, p_range_end::date, interval '1 day') AS d
  )
  SELECT jsonb_build_object(
    'kpis', to_jsonb(t.*),
    'listings_funnel', to_jsonb(lf.*),
    'trend', COALESCE((SELECT jsonb_agg(to_jsonb(ds.*) ORDER BY ds.day) FROM daily_series ds), '[]'::jsonb),
    'generated_at', now()
  )
  INTO v_result
  FROM totals t, listings_funnel lf;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_ops_overview(timestamptz, timestamptz) TO authenticated;
