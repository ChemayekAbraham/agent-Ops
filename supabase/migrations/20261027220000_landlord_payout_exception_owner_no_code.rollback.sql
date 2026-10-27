-- Puts the emailed approval code back on "Allow with exception" for everyone, the owner included.

CREATE OR REPLACE FUNCTION public.allow_landlord_payouts_with_exception(p_withdrawal_ids uuid[], p_reason text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.use_verified_exception_approval('landlord_payout_exception', p_withdrawal_ids, p_reason);
  RETURN public.allow_landlord_payouts_with_exception_unchecked(p_withdrawal_ids, p_reason);
END;
$function$;
