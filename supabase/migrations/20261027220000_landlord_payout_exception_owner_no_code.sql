-- "Allow with exception" (landlord payouts of agents under the weekly target) no longer asks the owner's own account for an emailed approval code.
-- Every other person still needs the code, exactly as before.
--
-- WHY: 20261027200000 let the owner change the payout goal and allow selected payouts without a code, but left this one behind. No screen asks for the
-- code, so none was ever sent, and the owner could not allow an under-target agent's payout with an exception.
--
-- HOW: the same owner check as 20261027200000 (public._is_landlord_payout_owner(): the owner's user id AND the email in the signed-in token). Only the
-- code check is skipped. The reason (5 characters at least), the role check, the audit row with the agent's weekly figures, and the goal limit all still
-- apply. Needs 20261027200000. Roll back with 20261027220000_landlord_payout_exception_owner_no_code.rollback.sql.

CREATE OR REPLACE FUNCTION public.allow_landlord_payouts_with_exception(p_withdrawal_ids uuid[], p_reason text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public._is_landlord_payout_owner() THEN
    PERFORM public.use_verified_exception_approval('landlord_payout_exception', p_withdrawal_ids, p_reason);
  END IF;
  RETURN public.allow_landlord_payouts_with_exception_unchecked(p_withdrawal_ids, p_reason);
END;
$function$;
