-- Partnership summary for the Agent Ops product profile.
--
-- The dialog read investor_portfolios directly, but RLS only lets the owner, COO and managers
-- select rows, so Agent Ops always saw "No active portfolio". This returns just the totals the
-- dialog needs instead of widening table access.

CREATE OR REPLACE FUNCTION public.get_agent_partnership_summary(p_agent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v jsonb;
BEGIN
  IF NOT (
    coalesce(auth.role(), 'service_role') = 'service_role'
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = v_uid AND ur.enabled = true
        AND ur.role IN ('agent_ops','operations','manager','coo','cfo','ceo','super_admin','partner_ops','financial_ops'))
  ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'count', count(*),
    'amount', COALESCE(sum(investment_amount), 0),
    'earned', COALESCE(sum(total_roi_earned), 0),
    'monthly', COALESCE(sum(investment_amount * COALESCE(roi_percentage, 0) / 100), 0)
  ) INTO v
  FROM public.investor_portfolios
  WHERE investor_id = p_agent_id AND status = 'active';

  RETURN v;
END
$function$;

REVOKE ALL ON FUNCTION public.get_agent_partnership_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_agent_partnership_summary(uuid) TO authenticated, service_role;
