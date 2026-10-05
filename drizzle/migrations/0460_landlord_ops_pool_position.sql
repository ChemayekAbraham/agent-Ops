CREATE OR REPLACE FUNCTION public.landlord_ops_pool_position()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN auth.uid() IS NULL OR NOT (
      public.is_ops_role(auth.uid())
      OR public.has_role(auth.uid(), 'landlord_ops')
      OR public.has_role(auth.uid(), 'tenant_ops')
      OR public.has_role(auth.uid(), 'agent_ops')
      OR public.has_role(auth.uid(), 'operations')
      OR public.has_role(auth.uid(), 'financial_ops')
      OR public.has_role(auth.uid(), 'cfo')
      OR public.has_role(auth.uid(), 'coo')
      OR public.has_role(auth.uid(), 'ceo')
      OR public.has_role(auth.uid(), 'cto')
      OR public.has_role(auth.uid(), 'manager')
      OR public.has_role(auth.uid(), 'super_admin')
    ) THEN
      NULL::jsonb
    ELSE
      jsonb_build_object(
        'available_to_deploy', COALESCE(SUM(e.in_pool), 0),
        'portfolios', COUNT(DISTINCT e.portfolio_id),
        'entries', COUNT(*),
        'reserved', COALESCE(SUM(e.principal), 0),
        'deployed', COALESCE(SUM(e.deployed), 0),
        'returned', COALESCE(SUM(e.returned), 0),
        'out_with_tenants', COALESCE(SUM(e.out_with_tenants), 0)
      )
    END
  FROM landlord_pool_entries e;
$function$;

COMMENT ON FUNCTION public.landlord_ops_pool_position() IS 'Read-only Landlord Float Pool position: available to deploy (sum of in_pool across landlord_pool_entries) plus context totals. No writes.';

-- Callable by any signed-in user; the function itself returns NULL for
-- unauthorised callers (same role gate as landlord_ops_float_overview).
GRANT EXECUTE ON FUNCTION public.landlord_ops_pool_position() TO authenticated;