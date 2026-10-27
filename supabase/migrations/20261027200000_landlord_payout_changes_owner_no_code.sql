-- The owner's own account (Joshua Wanda, joshwanda17@gmail.com) can change the landlord payout goal and allow or re-block selected landlord payouts
-- WITHOUT an emailed approval code. Every other person still needs the code, exactly as before.
--
-- WHY: both changes were put behind a one-time emailed code (use_verified_scope_approval) and no screen asks for that code, so the owner could not
-- change the goal or allow payouts at all. The owner is the approver the code is emailed to, so asking the owner for a code to approve the owner's
-- own change adds nothing.
--
-- HOW: the account is matched on BOTH its user id and the email in its signed-in token, so a copy of the email on another account does not count.
-- The two wrappers skip the code check only for that account; the checked work (_unchecked functions, role checks, AAL2, the goal limit, audit
-- rows) is untouched. "Allow with exception" (under-target agents) still needs its own code for everyone.
-- Roll back with 20261027200000_landlord_payout_changes_owner_no_code.rollback.sql.

CREATE OR REPLACE FUNCTION public._is_landlord_payout_owner()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT auth.uid() = 'cb798acb-68bc-4b4e-a414-a3d374e030b6'::uuid
     AND lower(COALESCE(auth.jwt() ->> 'email', '')) = 'joshwanda17@gmail.com';
$function$;
REVOKE ALL ON FUNCTION public._is_landlord_payout_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._is_landlord_payout_owner() TO authenticated;

CREATE OR REPLACE FUNCTION public.set_landlord_payout_budget(p_budget numeric, p_restart boolean DEFAULT false)
RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public._is_landlord_payout_owner() THEN
    PERFORM public.use_verified_scope_approval('landlord_payout_budget_change', ARRAY['00000000-0000-0000-0000-000000000001'::uuid],
      'budget=' || COALESCE(trunc(NULLIF(p_budget, 0))::text, 'none') || '|restart=' || COALESCE(p_restart, false)::text);
  END IF;
  RETURN public.set_landlord_payout_budget_unchecked(p_budget, p_restart);
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_landlord_payout_block_exemption(p_withdrawal_ids uuid[], p_allow boolean)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public._is_landlord_payout_owner() THEN
    PERFORM public.use_verified_scope_approval('landlord_payout_block_change', p_withdrawal_ids, CASE WHEN p_allow THEN 'allow' ELSE 'block' END);
  END IF;
  RETURN public.set_landlord_payout_block_exemption_unchecked(p_withdrawal_ids, p_allow);
END;
$function$;
