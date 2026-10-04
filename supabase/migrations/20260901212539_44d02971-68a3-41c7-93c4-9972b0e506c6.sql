DROP FUNCTION IF EXISTS public.partner_ops_pending_portfolio_lines(uuid);

CREATE OR REPLACE FUNCTION public.partner_ops_pending_portfolio_lines(p_portfolio_id uuid)
RETURNS TABLE(
  line_id uuid,
  line_kind text,
  principal numeric,
  subject_id uuid,
  subject_name text,
  subject_phone text,
  location text,
  daily_repayment numeric,
  counterparty_name text
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
  -- Tenant-bound rent plan lines
  SELECT l.id,
         'tenant'::text,
         l.principal,
         rr.tenant_id,
         coalesce(p.full_name, 'Tenant')::text,
         p.phone::text,
         nullif(concat_ws(', ', rr.request_city, rr.request_country), '')::text,
         rr.daily_repayment,
         NULL::text
  FROM public.funder_pending_portfolios fp
  JOIN public.partner_self_funding_lines l ON l.commitment_id = fp.commitment_id
  LEFT JOIN public.rent_requests rr ON rr.id = l.rent_request_id
  LEFT JOIN public.profiles p ON p.id = rr.tenant_id
  WHERE fp.portfolio_id = p_portfolio_id
    AND coalesce(l.status, 'active') <> 'cancelled'

  UNION ALL

  -- Verified empty-house support lines
  SELECT s.id,
         'house'::text,
         s.principal,
         s.house_id,
         coalesce(
           nullif(h.title, ''),
           nullif(replace(coalesce(h.house_category, ''), '_', ' '), ''),
           'Empty house'
         )::text,
         lp.phone::text,
         nullif(concat_ws(', ', nullif(h.address, ''), nullif(h.village, ''), nullif(h.district, '')), '')::text,
         NULL::numeric,
         nullif(lp.full_name, '')::text
  FROM public.funder_pending_portfolios fp
  JOIN public.partner_supported_houses s ON s.commitment_id = fp.commitment_id
  LEFT JOIN public.house_listings h ON h.id = s.house_id
  LEFT JOIN public.profiles lp ON lp.id = s.landlord_id
  WHERE fp.portfolio_id = p_portfolio_id
    AND coalesce(s.status, 'active') <> 'cancelled'

  ORDER BY 3 DESC;
END;
$$;