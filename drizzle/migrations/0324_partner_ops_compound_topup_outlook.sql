CREATE OR REPLACE FUNCTION public.get_partner_ops_compound_topup_outlook(p_end date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH comp AS (
  SELECT id, investment_amount, next_roi_date,
         round(investment_amount * coalesce(roi_percentage,15) / 100.0) AS cycle_amt
  FROM investor_portfolios
  WHERE status = 'active' AND roi_mode IN ('monthly_compounding','compound')
),
tu AS (
  SELECT o.amount, o.status, p.next_roi_date
  FROM pending_wallet_operations o
  LEFT JOIN investor_portfolios p ON p.id::text = o.source_id::text AND o.source_table = 'investor_portfolios'
  WHERE o.category = 'pending_portfolio_topup' AND o.operation_type = 'portfolio_topup'
    AND o.status IN ('pending','approved','awaiting_verification')
),
days AS (SELECT (p_end + g)::date AS day FROM generate_series(1,7) g)
SELECT jsonb_build_object(
  'compound_current', jsonb_build_object(
    'count', (SELECT count(*) FROM comp),
    'value', (SELECT coalesce(sum(investment_amount),0) FROM comp)),
  'compound_forecast', jsonb_build_object(
    'count', (SELECT count(*) FROM comp WHERE next_roi_date::date BETWEEN p_end+1 AND p_end+7),
    'amount', (SELECT coalesce(sum(cycle_amt),0) FROM comp WHERE next_roi_date::date BETWEEN p_end+1 AND p_end+7),
    'value_after', (SELECT coalesce(sum(investment_amount),0) FROM comp) + (SELECT coalesce(sum(cycle_amt),0) FROM comp WHERE next_roi_date::date BETWEEN p_end+1 AND p_end+7)),
  'topup_current', jsonb_build_object(
    'count', (SELECT count(*) FROM tu),
    'value', (SELECT coalesce(sum(amount),0) FROM tu),
    'approved_count', (SELECT count(*) FROM tu WHERE status='approved'),
    'approved_value', (SELECT coalesce(sum(amount),0) FROM tu WHERE status='approved')),
  'topup_forecast', jsonb_build_object(
    'count', (SELECT count(*) FROM tu WHERE status='approved' AND next_roi_date::date <= p_end+7),
    'amount', (SELECT coalesce(sum(amount),0) FROM tu WHERE status='approved' AND next_roi_date::date <= p_end+7)),
  'days', (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'day', d.day,
      'compound_count', (SELECT count(*) FROM comp c WHERE c.next_roi_date::date = d.day),
      'compound_amount', (SELECT coalesce(sum(cycle_amt),0) FROM comp c WHERE c.next_roi_date::date = d.day),
      'topup_count', (SELECT count(*) FROM tu t WHERE t.status='approved' AND t.next_roi_date::date = d.day),
      'topup_amount', (SELECT coalesce(sum(amount),0) FROM tu t WHERE t.status='approved' AND t.next_roi_date::date = d.day)
    ) ORDER BY d.day),'[]'::jsonb) FROM days d)
);
$$;
REVOKE ALL ON FUNCTION public.get_partner_ops_compound_topup_outlook(date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_partner_ops_compound_topup_outlook(date) TO service_role;