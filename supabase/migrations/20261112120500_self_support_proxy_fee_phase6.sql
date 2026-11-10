-- Self-support agent facilitation fee, Phase 6 (data for the screens).
--
-- partner_ops_pending_portfolio_lines now also returns, per line: rent_amount (to landlord float or
-- operational funding), proxy_fee (to the proxy agent at approval) and proxy_fee_status. principal is
-- still the partner's principal (rent + fee). Adding output columns needs DROP + CREATE, which resets
-- grants, so the existing grant (authenticated; the function checks the role itself) is restored.

DROP FUNCTION IF EXISTS public.partner_ops_pending_portfolio_lines(uuid);
CREATE OR REPLACE FUNCTION public.partner_ops_pending_portfolio_lines(p_portfolio_id uuid)
 RETURNS TABLE(line_id uuid, line_kind text, principal numeric, subject_id uuid, subject_name text, subject_phone text, location text, daily_repayment numeric, counterparty_name text, rent_amount numeric, proxy_fee numeric, proxy_fee_status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
         NULL::text,
         coalesce(l.rent_amount, l.principal),
         coalesce(l.proxy_fee, 0),
         l.proxy_fee_status
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
         nullif(lp.name, '')::text,
         coalesce(s.rent_amount, s.principal),
         coalesce(s.proxy_fee, 0),
         s.proxy_fee_status
  FROM public.funder_pending_portfolios fp
  JOIN public.partner_supported_houses s ON s.commitment_id = fp.commitment_id
  LEFT JOIN public.house_listings h ON h.id = s.house_id
  LEFT JOIN public.landlords lp ON lp.id = s.landlord_id
  WHERE fp.portfolio_id = p_portfolio_id
    AND coalesce(s.status, 'active') <> 'cancelled'

  ORDER BY 3 DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.partner_ops_pending_portfolio_lines(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_ops_pending_portfolio_lines(uuid) TO authenticated, service_role;
