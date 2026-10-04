CREATE OR REPLACE FUNCTION public.get_agent_commission_earned(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
RETURNS TABLE(agent_id uuid, commission_earned numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_to date := COALESCE(p_to, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_from date := COALESCE(p_from, v_to);
  v_start timestamptz;
  v_end timestamptz;
BEGIN
  IF NOT public.agent_ops_report_authorized() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  v_start := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end := ((v_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');

  RETURN QUERY
  SELECT gl.user_id AS agent_id,
         COALESCE(sum(gl.amount), 0)::numeric AS commission_earned
  FROM general_ledger gl
  WHERE gl.ledger_scope = 'wallet'
    AND gl.direction = 'cash_in'
    AND gl.user_id IS NOT NULL
    AND gl.category IN ('agent_commission','agent_commission_earned','agent_investment_commission','proxy_investment_commission')
    AND gl.transaction_date >= v_start
    AND gl.transaction_date < v_end
    AND COALESCE(gl.classification,'') <> 'admin_correction'
  GROUP BY gl.user_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_agent_commission_earned(date, date) TO authenticated;