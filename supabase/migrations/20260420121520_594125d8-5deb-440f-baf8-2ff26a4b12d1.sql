
CREATE OR REPLACE FUNCTION public.get_agent_ops_kpis()
RETURNS TABLE(agents bigint, earnings_total numeric, commissions_total numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (SELECT count(*)::bigint FROM public.user_roles WHERE role = 'agent'),
    COALESCE((SELECT sum(amount) FROM public.agent_earnings), 0)::numeric,
    COALESCE((SELECT sum(amount) FROM public.agent_commission_payouts), 0)::numeric;
$$;

REVOKE ALL ON FUNCTION public.get_agent_ops_kpis() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_agent_ops_kpis() TO authenticated;
