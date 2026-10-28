CREATE OR REPLACE FUNCTION public.get_cfo_received_agent_products_breakdown(p_from date, p_to date)
RETURNS TABLE(product_key text, product_label text, amount numeric, tx_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
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
      CASE
        WHEN g.category = 'bike_recovery_repayment' OR (g.source_table = 'merchandise_recovery_plans' AND COALESCE(mp.is_bike_lease, false)) THEN 'bike'
        WHEN g.source_table = 'merchandise_recovery_plans' OR g.category = 'merchandise_recovery_repayment' THEN 'smartphone'
        ELSE 'advance' END AS k
    FROM public.general_ledger g
    LEFT JOIN public.merchandise_recovery_plans mp ON g.source_table = 'merchandise_recovery_plans' AND mp.id = g.source_id::uuid
    WHERE g.direction = 'cash_in' AND g.ledger_scope = 'platform'
      AND g.classification IN ('production', 'legacy_real')
      AND g.transaction_date >= v_from AND g.transaction_date < v_to
      AND public._cfo_received_category_for(g.category) = 'agent'
  )
  SELECT x.k,
    CASE x.k WHEN 'smartphone' THEN 'Smartphone recoveries' WHEN 'bike' THEN 'Bike recoveries' ELSE 'Agent advance repayments' END,
    round(sum(x.amount), 2), count(*)
  FROM x GROUP BY x.k ORDER BY 3 DESC;
END $$;
REVOKE ALL ON FUNCTION public.get_cfo_received_agent_products_breakdown(date, date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_cfo_received_agent_products_breakdown(date, date) TO authenticated;