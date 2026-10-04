CREATE OR REPLACE FUNCTION public.prevent_duplicate_pending_withdrawal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  duplicate_id uuid;
  window_minutes int := 10;
BEGIN
  -- Only guard fresh submissions awaiting operator action. Approved /
  -- rejected / completed rows must not block legitimate re-tries.
  IF NEW.status IS DISTINCT FROM 'pending' THEN
    RETURN NEW;
  END IF;

  -- Mobile money: same provider + same normalised phone + same amount.
  IF NEW.payout_method = 'mobile_money'
     AND NEW.mobile_money_number IS NOT NULL THEN
    SELECT id INTO duplicate_id
    FROM public.withdrawal_requests
    WHERE user_id = NEW.user_id
      AND status = 'pending'
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
      AND status = 'pending'
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
      AND status = 'pending'
      AND payout_method = 'cash'
      AND coalesce(agent_location, '') = coalesce(NEW.agent_location, '')
      AND amount = NEW.amount
      AND created_at > now() - make_interval(mins => window_minutes)
    LIMIT 1;
  END IF;

  IF duplicate_id IS NOT NULL THEN
    RAISE EXCEPTION
      'DUPLICATE_PENDING_WITHDRAWAL: identical pending request already exists (id=%)',
      duplicate_id
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_duplicate_pending_withdrawal
  ON public.withdrawal_requests;

CREATE TRIGGER trg_prevent_duplicate_pending_withdrawal
BEFORE INSERT ON public.withdrawal_requests
FOR EACH ROW
EXECUTE FUNCTION public.prevent_duplicate_pending_withdrawal();

-- Speed up the lookup. The trigger filters by user_id + status + recent
-- created_at; this partial index keeps the check cheap even at scale.
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_user_pending_recent
  ON public.withdrawal_requests (user_id, payout_method, amount, created_at DESC)
  WHERE status = 'pending';