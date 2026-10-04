CREATE OR REPLACE FUNCTION public.prevent_duplicate_pending_withdrawal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  duplicate_id uuid;
  window_minutes int := 15;
BEGIN
  -- Only guard fresh submissions (rows are created as 'pending') and rows
  -- still being approved by operators. Terminal-state inserts (rare, e.g.
  -- back-office corrections) are never guarded.
  IF NEW.status IS DISTINCT FROM 'pending'
     AND NEW.status IS DISTINCT FROM 'manager_approved' THEN
    RETURN NEW;
  END IF;

  -- NOTE: the lookback now matches ANY recent identical request that is not
  -- explicitly cancelled — including ones already completed/rejected/approved
  -- within the window. This kills the rapid resubmission pattern where a user
  -- submits, the request is processed or rejected within a minute or two, and
  -- they immediately fire the same amount again.

  -- Mobile money: same provider + same normalised phone + same amount.
  IF NEW.payout_method = 'mobile_money'
     AND NEW.mobile_money_number IS NOT NULL THEN
    SELECT id INTO duplicate_id
    FROM public.withdrawal_requests
    WHERE user_id = NEW.user_id
      AND status <> 'cancelled'
      AND payout_method = 'mobile_money'
      AND mobile_money_provider IS NOT DISTINCT FROM NEW.mobile_money_provider
      AND regexp_replace(coalesce(mobile_money_number, ''), '\D', '', 'g')
          = regexp_replace(coalesce(NEW.mobile_money_number, ''), '\D', '', 'g')
      AND amount = NEW.amount
      AND created_at > now() - make_interval(mins => window_minutes)
    LIMIT 1;

  -- Bank: same bank + same account number + same amount.
  ELSIF NEW.payout_method = 'bank_transfer'
        AND NEW.bank_account_number IS NOT NULL THEN
    SELECT id INTO duplicate_id
    FROM public.withdrawal_requests
    WHERE user_id = NEW.user_id
      AND status <> 'cancelled'
      AND payout_method = 'bank_transfer'
      AND bank_name IS NOT DISTINCT FROM NEW.bank_name
      AND bank_account_number = NEW.bank_account_number
      AND amount = NEW.amount
      AND created_at > now() - make_interval(mins => window_minutes)
    LIMIT 1;

  -- Cash: same agent location + same amount.
  ELSIF NEW.payout_method = 'cash' THEN
    SELECT id INTO duplicate_id
    FROM public.withdrawal_requests
    WHERE user_id = NEW.user_id
      AND status <> 'cancelled'
      AND payout_method = 'cash'
      AND coalesce(agent_location, '') = coalesce(NEW.agent_location, '')
      AND amount = NEW.amount
      AND created_at > now() - make_interval(mins => window_minutes)
    LIMIT 1;
  END IF;

  -- Agent proxy-partner pattern: payout_method may be null at insert time;
  -- the dedupe key is (agent user_id, partner id, amount).
  IF duplicate_id IS NULL
     AND NEW.proxy_partner_id IS NOT NULL THEN
    SELECT id INTO duplicate_id
    FROM public.withdrawal_requests
    WHERE user_id = NEW.user_id
      AND status <> 'cancelled'
      AND proxy_partner_id = NEW.proxy_partner_id
      AND amount = NEW.amount
      AND created_at > now() - make_interval(mins => window_minutes)
    LIMIT 1;
  END IF;

  IF duplicate_id IS NOT NULL THEN
    RAISE EXCEPTION
      'DUPLICATE_PENDING_WITHDRAWAL: identical request submitted in the last % minutes (id=%)',
      window_minutes, duplicate_id
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$function$;