CREATE OR REPLACE FUNCTION public.landlord_payout_allowed_today()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(SUM(w.amount), 0)
    FROM public.withdrawal_requests w
   WHERE w.landlord_payout_id IS NOT NULL
     AND w.landlord_block_exempt_at >= (date_trunc('day', now() AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala');
$function$
