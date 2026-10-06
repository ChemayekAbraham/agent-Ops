-- Doc 199: the advance-withdrawal lock subtracted advance credits that never
-- entered the withdrawable bucket.
--
-- Since 2026-08-26 agent_advance_credit rows are written with
-- wallet_bucket = 'advance_credit' and tracked in wallet_balances_projection.
-- advance_balance, NOT withdrawable. get_user_available_balance() subtracts
-- get_advance_locked_withdrawable() from withdrawable while the
-- advance_withdrawals_paused control is on, so for those users the advance was
-- taken out of a balance that never held it and their own commission was
-- blocked (Joel Kayongo: withdrawable 34,762, lock 47,426, available 0).
--
-- Only credits that landed in the withdrawable bucket can be spent as cash, so
-- only those are locked. Legacy credits (wallet_bucket = 'withdrawable', up to
-- 2026-09-29) are locked exactly as before. Body otherwise unchanged.
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
