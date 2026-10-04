CREATE OR REPLACE FUNCTION public.get_user_float_available_balance(p_user_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT GREATEST(0, COALESCE((SELECT s.float_balance FROM public.user_wallet_strict(p_user_id) s), 0));
$function$;