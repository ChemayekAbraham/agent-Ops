CREATE OR REPLACE FUNCTION public.get_advance_locked_withdrawable(p_user_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH credits AS (
    SELECT COALESCE(SUM(amount), 0)::numeric AS total,
           MIN(transaction_date) AS first_at
    FROM public.general_ledger
    WHERE user_id = p_user_id
      AND ledger_scope = 'wallet'
      AND direction = 'cash_in'
      AND category = 'agent_advance_credit'
      AND COALESCE(wallet_bucket, 'withdrawable') = 'withdrawable'
      AND COALESCE(classification, 'production') <> 'admin_correction'
  ),
  outflows AS (
    SELECT COALESCE(SUM(g.amount), 0)::numeric AS total
    FROM public.general_ledger g, credits c
    WHERE g.user_id = p_user_id
      AND g.ledger_scope = 'wallet'
      AND g.direction = 'cash_out'
      AND c.first_at IS NOT NULL
      AND g.transaction_date >= c.first_at
      AND COALESCE(g.classification, 'production') <> 'admin_correction'
      AND g.category <> 'system_balance_correction'
  )
  SELECT GREATEST(0::numeric, (SELECT total FROM credits) - (SELECT total FROM outflows));
$function$;