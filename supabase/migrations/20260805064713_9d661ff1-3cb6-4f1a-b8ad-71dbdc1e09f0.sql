CREATE OR REPLACE FUNCTION public.partner_ops_report_totals()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'partner_ops')
    OR public.has_role(auth.uid(), 'financial_ops')
  ) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  SELECT jsonb_build_object(
    'total_partners', (SELECT count(DISTINCT investor_id) FROM investor_portfolios WHERE investor_id IS NOT NULL),
    'total_portfolios', (SELECT count(*) FROM investor_portfolios),
    'total_aum', (SELECT COALESCE(sum(investment_amount), 0) FROM investor_portfolios),
    'verified_portfolios_all', (SELECT count(*) FROM investor_portfolios WHERE cfo_verified IS TRUE),
    'verified_aum_all', (SELECT COALESCE(sum(investment_amount), 0) FROM investor_portfolios WHERE cfo_verified IS TRUE),
    'partners_30d', (SELECT count(DISTINCT investor_id) FROM investor_portfolios WHERE investor_id IS NOT NULL AND created_at >= now() - interval '30 days'),
    'new_partners_30d', (
      SELECT count(*) FROM (
        SELECT investor_id, min(created_at) AS first_at
        FROM investor_portfolios
        WHERE investor_id IS NOT NULL
        GROUP BY investor_id
      ) f WHERE f.first_at >= now() - interval '30 days'
    ),
    'portfolios_30d', (SELECT count(*) FROM investor_portfolios WHERE created_at >= now() - interval '30 days'),
    'aum_30d', (SELECT COALESCE(sum(investment_amount), 0) FROM investor_portfolios WHERE created_at >= now() - interval '30 days'),
    'verified_30d', (SELECT count(*) FROM investor_portfolios WHERE cfo_verified IS TRUE AND created_at >= now() - interval '30 days'),
    'pending_review_all', (SELECT count(*) FROM investor_portfolios WHERE cfo_verified IS NOT TRUE AND cfo_rejection_reason IS NULL),
    'rejected_all', (SELECT count(*) FROM investor_portfolios WHERE cfo_rejection_reason IS NOT NULL),
    'pending_withdrawals', (SELECT count(*) FROM investment_withdrawal_requests WHERE status = 'pending'),
    'pending_withdrawal_amount', (SELECT COALESCE(sum(amount), 0) FROM investment_withdrawal_requests WHERE status = 'pending')
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.partner_ops_report_totals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.partner_ops_report_totals() TO authenticated;
GRANT EXECUTE ON FUNCTION public.partner_ops_report_totals() TO service_role;