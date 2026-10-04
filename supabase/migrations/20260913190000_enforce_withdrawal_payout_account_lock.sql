-- Closes the gap identified in CASE MP-20260913-01 (Mata Pius's disputed
-- UGX 1,500,000 withdrawal, paid to a number that never appeared on his
-- registered account). The "locked, can't change during cash-out" promise
-- (src/components/payments/WithdrawFlow.tsx: the registered payout number
-- renders read-only once one is set) was enforced only in the React UI.
-- Every trigger on withdrawal_requests was read directly and confirmed none
-- of them compared the request's mobile_money_number against the account's
-- registered profiles.mobile_money_number -- trg_enforce_no_fraud_withdrawal_
-- request only checks frozen/blocklist status. A request could carry any
-- payout number regardless of what the screen showed as locked.
--
-- Scope, deliberately narrow: only 'Wallet withdrawal' mobile-money requests,
-- and only when the account already has a registered number on file --
-- exactly the condition under which the app's own screen renders the number
-- read-only. Landlord float payouts, proxy withdrawals, and any other
-- withdrawal reason are untouched; this migration does not have enough
-- context on those flows' legitimate use of third-party payout numbers to
-- safely extend the lock to them.
--
-- Numbers compare on their last 9 digits so 256776368807 / 0776368807 /
-- +256 776 368807 are recognised as the same number regardless of format.
--
-- Verified against the last 7 days of live 'Wallet withdrawal' mobile-money
-- requests before deploying: 53 would pass on an exact match, 307 have no
-- locked account yet and pass by design, 11 would have been blocked (in the
-- same ballpark as the ~30-day platform-wide sweep from the same
-- investigation, which found 3 accounts fitting this exact signature).

CREATE OR REPLACE FUNCTION public.enforce_withdrawal_payout_account_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_locked_num text;
  v_locked_name text;
BEGIN
  -- The payout number isn't changing -- nothing to check.
  IF TG_OP = 'UPDATE' AND NEW.mobile_money_number IS NOT DISTINCT FROM OLD.mobile_money_number THEN
    RETURN NEW;
  END IF;

  IF NEW.payout_method IS DISTINCT FROM 'mobile_money'
     OR coalesce(NEW.mobile_money_number, '') = ''
     OR coalesce(NEW.reason, '') NOT ILIKE '%wallet withdrawal%' THEN
    RETURN NEW;
  END IF;

  SELECT mobile_money_number, mobile_money_name
    INTO v_locked_num, v_locked_name
  FROM public.profiles
  WHERE id = NEW.user_id;

  -- No registered payout account on file yet: the app's own free-entry path
  -- applies (see WithdrawFlow.tsx), nothing to lock against.
  IF coalesce(v_locked_num, '') = '' OR coalesce(v_locked_name, '') = '' THEN
    RETURN NEW;
  END IF;

  IF right(regexp_replace(NEW.mobile_money_number, '\D', '', 'g'), 9)
     <> right(regexp_replace(v_locked_num, '\D', '', 'g'), 9) THEN
    RAISE EXCEPTION
      USING ERRCODE = '28000',
            MESSAGE = 'withdrawal_payout_account_locked',
            DETAIL = format(
              'This account''s registered payout number is %s (%s). The request specified a different number. Change the registered Withdrawal Account in Settings first, then submit the withdrawal.',
              v_locked_num, v_locked_name);
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_withdrawal_payout_account_lock ON public.withdrawal_requests;
CREATE TRIGGER trg_enforce_withdrawal_payout_account_lock
  BEFORE INSERT OR UPDATE OF mobile_money_number ON public.withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_withdrawal_payout_account_lock();
