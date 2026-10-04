CREATE OR REPLACE FUNCTION public.partner_ops_pending_portfolio_lines(p_portfolio_id uuid)
RETURNS TABLE (
  line_id uuid,
  principal numeric,
  tenant_id uuid,
  tenant_name text,
  tenant_phone text,
  location text,
  daily_repayment numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'partner_ops') OR public.has_role(auth.uid(), 'operations')
    OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'financial_ops')
    OR public.has_role(auth.uid(), 'admin')
  ) THEN
    RAISE EXCEPTION 'Not authorised to view portfolio lines';
  END IF;

  RETURN QUERY
  SELECT l.id,
         l.principal,
         rr.tenant_id,
         coalesce(p.full_name, 'Tenant'),
         p.phone,
         nullif(concat_ws(', ', rr.request_city, rr.request_country), ''),
         rr.daily_repayment
  FROM public.funder_pending_portfolios fp
  JOIN public.partner_self_funding_lines l ON l.commitment_id = fp.commitment_id
  LEFT JOIN public.rent_requests rr ON rr.id = l.rent_request_id
  LEFT JOIN public.profiles p ON p.id = rr.tenant_id
  WHERE fp.portfolio_id = p_portfolio_id
  ORDER BY l.principal DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.partner_ops_pending_portfolio_lines(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.partner_ops_pending_portfolio_lines(uuid) FROM anon;