CREATE OR REPLACE FUNCTION public.landlord_payout_goal_allowed()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT COALESCE(SUM(w.amount), 0) FROM public.withdrawal_requests w
     WHERE w.landlord_payout_id IS NOT NULL AND w.landlord_block_exempt_at >= public.landlord_payout_goal_started_at();
  $function$
