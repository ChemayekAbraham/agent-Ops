CREATE OR REPLACE FUNCTION public._cfo_received_category_for(p_category text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE p_category
    WHEN 'partner_funding' THEN 'partner'
    WHEN 'tenant_repayment_collected' THEN 'land'
    WHEN 'tenant_repayment' THEN 'land'
    WHEN 'landlord_receivable_collected' THEN 'land'
    WHEN 'agent_advance_repayment' THEN 'agent'
    WHEN 'agent_repayment' THEN 'agent'
    WHEN 'bike_recovery_repayment' THEN 'agent'
    WHEN 'merchandise_recovery_repayment' THEN 'agent'
    WHEN 'listing_rejection_recovery' THEN 'agent'
    WHEN 'platform_fee_collected' THEN 'fees'
    WHEN 'access_fee_collected' THEN 'fees'
    WHEN 'agent_advance_fee_revenue' THEN 'fees'
    WHEN 'agent_advance_access_fee_collected' THEN 'fees'
    WHEN 'agent_advance_registration_fee_collected' THEN 'fees'
    WHEN 'share_capital' THEN 'capital'
    ELSE NULL END;
$function$;

CREATE OR REPLACE FUNCTION public._cfo_received_agent_product_for(p_category text, p_source_table text, p_is_bike_lease boolean)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p_category = 'listing_rejection_recovery' THEN 'rejection'
    WHEN p_category = 'bike_recovery_repayment'
      OR (p_source_table = 'merchandise_recovery_plans' AND COALESCE(p_is_bike_lease, false)) THEN 'bike'
    WHEN p_source_table = 'merchandise_recovery_plans'
      OR p_category = 'merchandise_recovery_repayment' THEN 'smartphone'
    ELSE 'advance'
  END;
$function$;

CREATE OR REPLACE FUNCTION public.get_cfo_received_agent_products_breakdown(p_from date, p_to date)
 RETURNS TABLE(product_key text, product_label text, amount numeric, tx_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_from timestamptz; v_to timestamptz;
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023'; END IF;
  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  RETURN QUERY
  WITH x AS (
    SELECT g.amount,
      public._cfo_received_agent_product_for(g.category, g.source_table, mp.is_bike_lease) AS k
    FROM public.general_ledger g
    LEFT JOIN public.merchandise_recovery_plans mp
      ON g.source_table = 'merchandise_recovery_plans' AND mp.id = g.source_id
    WHERE g.direction = 'cash_in' AND g.ledger_scope = 'platform'
      AND g.classification IN ('production', 'legacy_real')
      AND g.transaction_date >= v_from AND g.transaction_date < v_to
      AND public._cfo_received_category_for(g.category) = 'agent'
  )
  SELECT x.k,
    CASE x.k WHEN 'smartphone' THEN 'Smartphone recoveries' WHEN 'bike' THEN 'Bike recoveries'
             WHEN 'rejection' THEN 'Rejection charges' ELSE 'Agent advance repayments' END,
    round(sum(x.amount), 2), count(*)
  FROM x GROUP BY x.k ORDER BY 3 DESC;
END $function$;