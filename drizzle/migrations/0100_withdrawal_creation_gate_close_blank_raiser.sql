-- Close the blank-raiser hole in the withdrawal creation gate.
-- Previously `initiated_by IS DISTINCT FROM user_id` treated a NULL raiser as
-- "raised on someone else's behalf", so any insert that simply omitted
-- initiated_by skipped the payout-destination check entirely.
-- Now the on-behalf exemption requires an explicitly recorded raiser, and the
-- one legitimate system path that cannot record one (landlord float payouts,
-- where the destination is the landlord's phone, not the requester's) is
-- exempted explicitly instead of by accident.
CREATE OR REPLACE FUNCTION public.enforce_withdrawal_destination_verified()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF lower(coalesce(NEW.payout_method,'')) NOT IN ('mobile_money','bank_transfer') THEN
    RETURN NEW;
  END IF;

  -- System-routed landlord float payout: destination is the landlord's own
  -- phone, captured and verified in the landlord payout flow, not the
  -- requesting agent's registered destination.
  IF NEW.landlord_payout_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Genuinely raised on someone else's behalf (proxy/ops desk). A NULL raiser
  -- is NOT on-behalf -- it is an unattributed self-service row and stays gated.
  IF NEW.initiated_by IS NOT NULL AND NEW.initiated_by <> NEW.user_id THEN
    RETURN NEW;
  END IF;

  -- Funders holding an investor portfolio remain exempt (unchanged).
  IF public.user_is_funder_with_portfolio(NEW.user_id) THEN
    RETURN NEW;
  END IF;

  IF NOT public.payout_destination_is_verified(
       NEW.user_id, NEW.payout_method, NEW.mobile_money_number, NEW.bank_name, NEW.bank_account_number) THEN
    RAISE EXCEPTION 'This payout destination is not yet verified. Financial Ops will call you to confirm it belongs to you.';
  END IF;

  RETURN NEW;
END;
$function$;