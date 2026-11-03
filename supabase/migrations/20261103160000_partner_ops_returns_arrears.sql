-- Partner Ops: show, per portfolio due for a Returns payout, how much of that Returns
-- belongs to the company's smartphone arrears, so the officer pays out Returns minus arrears.
--
-- Read-only. It mirrors the arithmetic of apply_smartphone_roi_pledge (pledge = percent of, or a
-- fixed amount from, each Returns payment, capped at the Returns paid and at what is still owed
-- on the agent's smartphone plan) without posting anything. The Returns figure is the same one
-- Partner Ops already sees: investment_amount x roi_percentage / 100.
--
-- A partner with several portfolios due together shares one smartphone balance, so the cap is
-- applied across their portfolios in creation order and the balance is never counted twice.
-- It does not look at wallet balance (apply_smartphone_roi_pledge also caps at the wallet).

CREATE OR REPLACE FUNCTION public.get_partner_ops_returns_arrears(p_portfolio_ids uuid[])
RETURNS TABLE (
  portfolio_id uuid,
  investor_id uuid,
  expected_returns numeric,
  pledge_mode text,
  pledge_value numeric,
  arrears_deduction numeric,
  net_payout numeric,
  plan_outstanding numeric,
  plan_overdue numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.is_partner_ops(auth.uid()) OR public.can_view_staff_reports(auth.uid())) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH pf AS (
    SELECT ip.id, ip.investor_id AS owner_id, ip.created_at,
           round(COALESCE(ip.investment_amount, 0) * COALESCE(ip.roi_percentage, 15) / 100.0) AS expected
    FROM public.investor_portfolios ip
    WHERE ip.id = ANY (COALESCE(p_portfolio_ids, ARRAY[]::uuid[]))
  ),
  pledge AS (
    SELECT sp.user_id, sp.mode, sp.value
    FROM public.smartphone_roi_pledges sp
    WHERE sp.active
  ),
  plan AS (
    SELECT DISTINCT ON (p.customer_id)
           p.customer_id, p.outstanding_balance, COALESCE(p.due_balance, 0) AS overdue
    FROM public.merchandise_recovery_plans p
    JOIN public.merchandise_sales s ON s.id = p.sale_id
    WHERE p.status = 'active' AND p.outstanding_balance > 0
      AND NOT COALESCE(p.is_bike_lease, false) AND s.item_name ILIKE '%smartphone%'
    ORDER BY p.customer_id, p.created_at
  ),
  raw AS (
    SELECT pf.id, pf.owner_id, pf.created_at, pf.expected,
           pl.mode, pl.value, pn.outstanding_balance, pn.overdue,
           LEAST(
             CASE WHEN pl.mode = 'percent' THEN floor(pf.expected * pl.value / 100) ELSE pl.value END,
             pf.expected
           ) AS wanted
    FROM pf
    JOIN pledge pl ON pl.user_id = pf.owner_id
    JOIN plan pn ON pn.customer_id = pf.owner_id
  )
  SELECT r.id, r.owner_id, r.expected, r.mode, r.value,
         d.ded, r.expected - d.ded, r.outstanding_balance, r.overdue
  FROM raw r
  CROSS JOIN LATERAL (
    SELECT GREATEST(0, LEAST(
      r.wanted,
      r.outstanding_balance - COALESCE((
        SELECT sum(r2.wanted) FROM raw r2
        WHERE r2.owner_id = r.owner_id AND (r2.created_at, r2.id) < (r.created_at, r.id)
      ), 0)
    )) AS ded
  ) d
  ORDER BY r.owner_id, r.created_at, r.id;
END
$function$;

REVOKE ALL ON FUNCTION public.get_partner_ops_returns_arrears(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_partner_ops_returns_arrears(uuid[]) TO authenticated, service_role;
