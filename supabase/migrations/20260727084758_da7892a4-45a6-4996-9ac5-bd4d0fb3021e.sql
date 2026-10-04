CREATE OR REPLACE FUNCTION public.get_agent_ops_overview(p_range_start timestamptz, p_range_end timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
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
      (SELECT COALESCE(sum(rent_amount), 0) FROM public.rent_requests WHERE created_at >= p_range_start AND created_at < p_range_end) AS rent_req_amount_curr,
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
      (SELECT COALESCE(sum(outstanding_balance), 0) FROM public.agent_advances WHERE status IN ('active','disbursed','overdue')) AS outstanding_advances,
      (SELECT count(*) FROM public.agent_advances WHERE status IN ('active','disbursed','overdue')) AS active_advances_count,
      (SELECT COALESCE(sum(arrears_balance), 0) FROM public.agent_advances WHERE status IN ('active','disbursed','overdue')) AS arrears_total,
      (SELECT count(*) FROM public.agent_advance_requests WHERE status = 'pending') AS pending_advance_requests,
      (SELECT count(*) FROM public.house_listings WHERE created_at >= p_range_start AND created_at < p_range_end) AS listings_new,
      (SELECT count(*) FROM public.house_listings WHERE created_at >= p_range_start AND created_at < p_range_end AND verified = true) AS listings_verified,
      (SELECT count(*) FROM public.house_listings WHERE created_at >= p_range_start AND created_at < p_range_end AND rejection_reason IS NOT NULL) AS listings_rejected,
      (SELECT count(*) FROM public.rent_requests WHERE status = 'pending' AND created_at >= p_range_start) AS pipeline_pending,
      (SELECT count(*) FROM public.rent_requests WHERE status IN ('approved','disbursed','funded','repaying') AND created_at >= p_range_start) AS pipeline_active,
      (SELECT count(*) FROM public.rent_requests WHERE status IN ('rejected','deleted_by_agent') AND created_at >= p_range_start) AS pipeline_rejected
  )
  SELECT jsonb_build_object(
    'range', jsonb_build_object('start', p_range_start, 'end', p_range_end),
    'totals', to_jsonb(totals.*)
  ) INTO v_result
  FROM totals;

  RETURN v_result;
END;
$function$;