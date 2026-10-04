CREATE OR REPLACE FUNCTION public.get_withdrawable_wallet_holders_by_recent_withdrawal()
 RETURNS TABLE(user_id uuid, name text, phone text, withdrawable_balance numeric, latest_withdrawal_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    w.user_id,
    p.full_name,
    p.phone,
    w.withdrawable_balance,
    latest.latest_withdrawal_at
  FROM public.wallets w
  LEFT JOIN public.profiles p ON p.id = w.user_id
  LEFT JOIN LATERAL (
    SELECT wr.created_at AS latest_withdrawal_at
    FROM public.withdrawal_requests wr
    WHERE wr.user_id = w.user_id
    ORDER BY wr.created_at DESC
    LIMIT 1
  ) latest ON true
  WHERE w.withdrawable_balance > 0
  ORDER BY latest.latest_withdrawal_at DESC NULLS LAST, w.withdrawable_balance DESC
  LIMIT 5000;
$function$;