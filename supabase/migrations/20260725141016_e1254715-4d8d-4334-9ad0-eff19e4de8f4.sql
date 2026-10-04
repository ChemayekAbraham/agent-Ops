-- Fix: rent request insert fires trg_mature_on_rent_request -> mature_referral_bonuses_for_invitee,
-- which does a direct UPDATE on public.general_ledger to flip the maturity flag on referral-bonus
-- rows. The enforce_ledger_rpc_only trigger blocks any UPDATE that hasn't set the
-- `ledger.authorized` session flag, which surfaces to the agent as:
--   "general_ledger UPDATE blocked: writes must go through create_ledger_transaction RPC."
--
-- These maturity updates are legitimate administrative flag flips (not value/direction writes),
-- so we convert both maturity helpers to plpgsql and set the authorization flag locally, matching
-- the pattern already used by try_credit_qualified_referrals, sync_collection_to_ledger, etc.

CREATE OR REPLACE FUNCTION public.mature_referral_bonuses_for_invitee(p_invitee_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  -- Authorize the maturity flag flip through the ledger guard for this txn only.
  PERFORM set_config('ledger.authorized', 'true', true);

  WITH refs AS (
    SELECT referrer_id FROM public.referrals WHERE referred_id = p_invitee_id
    UNION
    SELECT referrer_id FROM public.profiles
      WHERE id = p_invitee_id AND referrer_id IS NOT NULL
  ),
  upd AS (
    UPDATE public.general_ledger gl
       SET maturity_met = true, matured_at = now()
      FROM refs
     WHERE gl.user_id = refs.referrer_id
       AND gl.ledger_scope = 'wallet'
       AND gl.direction IN ('cash_in','credit')
       AND gl.category = 'referral_bonus'
       AND gl.maturity_met = false
       AND gl.maturity_expired = false
       AND now() <= gl.withdrawable_after
     RETURNING gl.id
  )
  SELECT count(*)::int INTO v_count FROM upd;

  -- Reset for the remainder of the transaction so unrelated writes still hit the guard.
  PERFORM set_config('ledger.authorized', 'false', true);

  RETURN COALESCE(v_count, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.mature_bonus_by_subject(p_condition text, p_subject_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM set_config('ledger.authorized', 'true', true);

  WITH upd AS (
    UPDATE public.general_ledger
       SET maturity_met = true, matured_at = now()
     WHERE ledger_scope = 'wallet'
       AND direction IN ('cash_in','credit')
       AND maturity_condition = p_condition
       AND maturity_subject_id = p_subject_id
       AND maturity_met = false
       AND maturity_expired = false
       AND now() <= withdrawable_after
     RETURNING id
  )
  SELECT count(*)::int INTO v_count FROM upd;

  PERFORM set_config('ledger.authorized', 'false', true);

  RETURN COALESCE(v_count, 0);
END;
$$;