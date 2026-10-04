CREATE OR REPLACE FUNCTION public.merchant_float_position_at(p_agent_id uuid, p_at timestamp with time zone)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(SUM(
           CASE WHEN g.direction IN ('cash_in', 'credit') THEN g.amount ELSE -g.amount END
         ), 0)
  FROM public.general_ledger g
  WHERE g.user_id = p_agent_id
    AND g.ledger_scope = 'wallet'
    AND g.wallet_bucket = 'float'
    AND g.transaction_date <= p_at;
$function$;