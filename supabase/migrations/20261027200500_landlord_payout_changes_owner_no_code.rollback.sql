-- Puts the emailed approval code back for everyone, the owner included.

CREATE OR REPLACE FUNCTION public.set_landlord_payout_budget(p_budget numeric, p_restart boolean DEFAULT false)
RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.use_verified_scope_approval('landlord_payout_budget_change', ARRAY['00000000-0000-0000-0000-000000000001'::uuid],
    'budget=' || COALESCE(trunc(NULLIF(p_budget, 0))::text, 'none') || '|restart=' || COALESCE(p_restart, false)::text);
  RETURN public.set_landlord_payout_budget_unchecked(p_budget, p_restart);
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_landlord_payout_block_exemption(p_withdrawal_ids uuid[], p_allow boolean)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.use_verified_scope_approval('landlord_payout_block_change', p_withdrawal_ids, CASE WHEN p_allow THEN 'allow' ELSE 'block' END);
  RETURN public.set_landlord_payout_block_exemption_unchecked(p_withdrawal_ids, p_allow);
END;
$function$;

DROP FUNCTION IF EXISTS public._is_landlord_payout_owner();
