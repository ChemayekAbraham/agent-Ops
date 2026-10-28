-- Smartphone application review: the "Partnership status" card read investor_portfolios straight
-- from the browser. Row-level security lets only the investor, their agent, managers and the COO
-- read that table, so every other reviewer (agent ops, CFO, CEO, CMO) silently got zero rows and
-- saw "No active portfolio" for applicants who do have one. Portfolios that were waiting on
-- approval, partner details or a lock were also lumped in with "none".
-- This returns the applicant's real standing, gated to the same reviewers as the products overview.
CREATE OR REPLACE FUNCTION public.get_applicant_partnership(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public._agent_products_authorized() THEN
    RAISE EXCEPTION 'Not authorized to view agent products' USING ERRCODE = '42501';
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'active_count',    COUNT(*) FILTER (WHERE status = 'active'),
      'active_amount',   COALESCE(SUM(investment_amount) FILTER (WHERE status = 'active'), 0),
      'active_earned',   COALESCE(SUM(total_roi_earned) FILTER (WHERE status = 'active'), 0),
      'active_monthly',  COALESCE(SUM(investment_amount * COALESCE(roi_percentage, 0) / 100) FILTER (WHERE status = 'active'), 0),
      'pending_count',   COUNT(*) FILTER (WHERE status IN ('pending_ops_approval', 'awaiting_partner_details')),
      'locked_count',    COUNT(*) FILTER (WHERE status = 'locked'),
      'redeemed_count',  COUNT(*) FILTER (WHERE status = 'redeemed')
    )
    FROM public.investor_portfolios
    WHERE investor_id = p_user_id
  );
END
$function$;

REVOKE ALL ON FUNCTION public.get_applicant_partnership(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_applicant_partnership(uuid) TO authenticated, service_role;
